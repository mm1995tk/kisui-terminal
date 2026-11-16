//! HTTP/3 の側。QUIC で受け、CONNECT（TCP）と CONNECT-UDP（QUIC の DATAGRAM）を運ぶ。

use std::collections::HashMap;
use std::error::Error;
use std::io;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::{Bytes, BytesMut};
use h3::ext::Protocol;
use h3::server::{RequestResolver, RequestStream};
use http::{Method, Request, Response, StatusCode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::connect::Ctx;
use crate::tls::Identity;
use crate::wire;

type BoxError = Box<dyn Error + Send + Sync>;
type H3Conn = h3_quinn::Connection;
type Stream = RequestStream<h3_quinn::BidiStream<Bytes>, Bytes>;

/// 流れが始まる前に届いた datagram を、1 つの流れにつき溜めておく数。
const EARLY_PER_FLOW: usize = 32;
/// 流れが始まる前に届いた datagram を溜めておく流れの数と、溜めておく長さ。
const EARLY_FLOWS: usize = 64;
const EARLY_TTL: Duration = Duration::from_secs(5);

/// UDP の流れごとの、受けた datagram の渡し先。鍵は 4 で割った stream の ID（RFC 9297 2.1）。
///
/// 頼む側（macOS）は、CONNECT-UDP の要求と一緒に、返事を待たずに最初の datagram（行き先への QUIC の
/// Initial）を送ってくる。行き先の名前を引いてつなぐまでの間に届いたものを捨てると、行き先との QUIC が
/// 始まらないので、流れが始まるまで少しの間だけ溜めておき、始まったら渡す。
#[derive(Default)]
struct Flows {
    inner: Mutex<FlowsInner>,
}

#[derive(Default)]
struct FlowsInner {
    open: HashMap<u64, mpsc::Sender<Bytes>>,
    early: HashMap<u64, (Instant, Vec<Bytes>)>,
}

impl Flows {
    fn deliver(&self, quarter_id: u64, payload: Bytes) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(tx) = inner.open.get(&quarter_id) {
            // 溢れたら捨てる（UDP なので、運ぶ側の QUIC が送り直す）
            let _ = tx.try_send(payload);
            return;
        }
        let now = Instant::now();
        inner
            .early
            .retain(|_, (since, _)| now.duration_since(*since) < EARLY_TTL);
        if inner.early.len() >= EARLY_FLOWS && !inner.early.contains_key(&quarter_id) {
            return;
        }
        let (_, queue) = inner
            .early
            .entry(quarter_id)
            .or_insert_with(|| (now, Vec::new()));
        if queue.len() < EARLY_PER_FLOW {
            queue.push(payload);
        }
    }

    fn open(&self, quarter_id: u64) -> mpsc::Receiver<Bytes> {
        let (tx, rx) = mpsc::channel(1024);
        let mut inner = self.inner.lock().unwrap();
        if let Some((_, early)) = inner.early.remove(&quarter_id) {
            for payload in early {
                let _ = tx.try_send(payload);
            }
        }
        inner.open.insert(quarter_id, tx);
        rx
    }

    fn close(&self, quarter_id: u64) {
        let mut inner = self.inner.lock().unwrap();
        inner.open.remove(&quarter_id);
        inner.early.remove(&quarter_id);
    }
}

/// 同じ機械の中（loopback）で受けるときの QUIC の最初の MTU。
/// 中に運ぶ QUIC の 1 つの packet（1200〜1500 バイト）を、DATAGRAM の枠と合わせて 1 つに入れるため。
/// 既定（1200）のままだと、行き先の QUIC の packet が入らず捨てることになる。
const LOOPBACK_INITIAL_MTU: u16 = 4096;

pub(crate) fn bind(addr: SocketAddr, identity: &Identity) -> io::Result<quinn::Endpoint> {
    let crypto = identity.server_config(b"h3")?;
    let quic =
        quinn::crypto::rustls::QuicServerConfig::try_from(crypto).map_err(io::Error::other)?;
    let mut server = quinn::ServerConfig::with_crypto(Arc::new(quic));
    let mut transport = quinn::TransportConfig::default();
    transport.max_idle_timeout(Some(
        Duration::from_secs(120)
            .try_into()
            .map_err(io::Error::other)?,
    ));
    transport.datagram_receive_buffer_size(Some(4 << 20));
    transport.datagram_send_buffer_size(4 << 20);
    if addr.ip().is_loopback() {
        transport.initial_mtu(LOOPBACK_INITIAL_MTU);
    }
    server.transport_config(Arc::new(transport));
    quinn::Endpoint::server(server, addr)
}

pub(crate) async fn serve(endpoint: quinn::Endpoint, ctx: Arc<Ctx>) {
    while let Some(incoming) = endpoint.accept().await {
        let ctx = ctx.clone();
        tokio::spawn(async move {
            if let Err(e) = connection(incoming, ctx.clone()).await {
                ctx.trace(format_args!("h3 connection ended: {e}"));
            }
        });
    }
}

async fn connection(incoming: quinn::Incoming, ctx: Arc<Ctx>) -> Result<(), BoxError> {
    let conn = incoming.await?;
    ctx.trace(format_args!("h3 connection from {}", conn.remote_address()));
    let mut h3 = h3::server::builder()
        .enable_extended_connect(true)
        .enable_datagram(true)
        .build::<_, Bytes>(H3Conn::new(conn.clone()))
        .await?;
    let flows = Arc::new(Flows::default());
    let reader = tokio::spawn(read_datagrams(conn.clone(), flows.clone()));
    let result = loop {
        match h3.accept().await {
            Ok(Some(resolver)) => {
                tokio::spawn(request(resolver, conn.clone(), flows.clone(), ctx.clone()));
            }
            Ok(None) => break Ok(()),
            Err(e) => break Err(e.into()),
        }
    };
    reader.abort();
    result
}

/// 接続に届いた DATAGRAM を、stream の ID で UDP の流れに振り分ける。
async fn read_datagrams(conn: quinn::Connection, flows: Arc<Flows>) {
    while let Ok(mut datagram) = conn.read_datagram().await {
        let Some(quarter_id) = wire::get_varint(&mut datagram) else {
            continue;
        };
        let Some(payload) = wire::udp_from_payload(datagram) else {
            continue;
        };
        flows.deliver(quarter_id, payload);
    }
}

async fn request(
    resolver: RequestResolver<H3Conn, Bytes>,
    conn: quinn::Connection,
    flows: Arc<Flows>,
    ctx: Arc<Ctx>,
) {
    let (req, stream) = match resolver.resolve_request().await {
        Ok(r) => r,
        Err(e) => {
            ctx.trace(format_args!("h3 request: {e}"));
            return;
        }
    };
    let quarter_id = stream.id().into_inner() / 4;
    let protocol = req.extensions().get::<Protocol>().copied();
    ctx.trace(format_args!(
        "h3 {} {} protocol={:?} headers={:?}",
        req.method(),
        req.uri(),
        protocol.map(|p| p.as_str().to_string()),
        req.headers()
    ));
    let result = match (req.method(), protocol) {
        (&Method::CONNECT, None) => tcp(req, stream, &ctx).await,
        (&Method::CONNECT, Some(p)) if p == Protocol::CONNECT_UDP => {
            udp(req, stream, conn, &flows, &ctx).await
        }
        _ => reject(stream, StatusCode::NOT_IMPLEMENTED).await,
    };
    flows.close(quarter_id);
    if let Err(e) = result {
        ctx.trace(format_args!("h3 stream ended: {e}"));
    }
}

async fn reject(mut stream: Stream, status: StatusCode) -> Result<(), BoxError> {
    stream
        .send_response(Response::builder().status(status).body(())?)
        .await?;
    stream.finish().await?;
    Ok(())
}

async fn tcp(req: Request<()>, mut stream: Stream, ctx: &Ctx) -> Result<(), BoxError> {
    let Some((host, port)) = req
        .uri()
        .authority()
        .and_then(|a| wire::parse_authority(a.as_str()))
    else {
        return reject(stream, StatusCode::BAD_REQUEST).await;
    };
    let target = match ctx.connect_tcp(&host, port).await {
        Ok(t) => t,
        Err(e) => {
            ctx.trace(format_args!("tcp {host}:{port}: {e}"));
            return reject(stream, StatusCode::BAD_GATEWAY).await;
        }
    };
    stream
        .send_response(Response::builder().status(StatusCode::OK).body(())?)
        .await?;
    let (mut send, mut recv) = stream.split();
    let (mut rd, mut wr) = target.into_split();
    let up = async {
        while let Some(mut chunk) = recv.recv_data().await? {
            wr.write_all_buf(&mut chunk).await?;
        }
        wr.shutdown().await?;
        Ok::<_, BoxError>(())
    };
    let down = async {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            let n = rd.read(&mut buf).await?;
            if n == 0 {
                send.finish().await?;
                return Ok::<_, BoxError>(());
            }
            send.send_data(Bytes::copy_from_slice(&buf[..n])).await?;
        }
    };
    tokio::try_join!(up, down)?;
    Ok(())
}

async fn udp(
    req: Request<()>,
    mut stream: Stream,
    conn: quinn::Connection,
    flows: &Flows,
    ctx: &Ctx,
) -> Result<(), BoxError> {
    let Some((host, port)) = wire::parse_udp_path(req.uri().path()) else {
        return reject(stream, StatusCode::BAD_REQUEST).await;
    };
    let socket = match ctx.connect_udp(&host, port).await {
        Ok(s) => s,
        Err(e) => {
            ctx.trace(format_args!("udp {host}:{port}: {e}"));
            return reject(stream, StatusCode::BAD_GATEWAY).await;
        }
    };
    let quarter_id = stream.id().into_inner() / 4;
    let mut rx = flows.open(quarter_id);
    stream
        .send_response(
            Response::builder()
                .status(StatusCode::OK)
                .header("capsule-protocol", "?1")
                .body(())?,
        )
        .await?;

    let up = async {
        while let Some(payload) = rx.recv().await {
            let _ = socket.send(&payload).await;
        }
    };
    let down = async {
        let mut buf = vec![0u8; 65536];
        loop {
            match socket.recv(&mut buf).await {
                Ok(n) => {
                    let mut datagram = BytesMut::with_capacity(n + 16);
                    wire::put_varint(&mut datagram, quarter_id);
                    datagram.extend_from_slice(&wire::udp_payload(&buf[..n]));
                    // 大きすぎるものなどは捨てる（UDP なので、運ぶ側の QUIC が送り直す）
                    let _ = conn.send_datagram(datagram.freeze());
                }
                // 行き先が閉じている（ICMP の port unreachable）だけなら続ける
                Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => {}
                Err(_) => return,
            }
        }
    };
    // 頼んだ側が stream を閉じたら終える。stream に来る capsule は今は使わない
    let closed = async { while let Ok(Some(_)) = stream.recv_data().await {} };
    tokio::select! {
        _ = up => {}
        _ = down => {}
        _ = closed => {}
    }
    let _ = stream.finish().await;
    Ok(())
}
