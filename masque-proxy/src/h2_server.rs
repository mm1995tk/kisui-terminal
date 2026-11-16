//! HTTP/2 の側。TLS の上で受け、CONNECT（TCP）と CONNECT-UDP（DATAGRAM の capsule）を運ぶ。
//! HTTP/3 が使えないとき（UDP が通らない回線など）に、頼む側が使う。

use std::error::Error;
use std::io;
use std::sync::Arc;

use bytes::{Bytes, BytesMut};
use h2::ext::Protocol;
use h2::server::SendResponse;
use h2::{RecvStream, SendStream};
use http::{Method, Request, Response, StatusCode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

use crate::connect::Ctx;
use crate::tls::Identity;
use crate::wire;

type BoxError = Box<dyn Error + Send + Sync>;

pub(crate) fn acceptor(identity: &Identity) -> io::Result<TlsAcceptor> {
    Ok(TlsAcceptor::from(Arc::new(identity.server_config(b"h2")?)))
}

pub(crate) async fn serve(listener: TcpListener, acceptor: TlsAcceptor, ctx: Arc<Ctx>) {
    loop {
        let Ok((tcp, peer)) = listener.accept().await else {
            continue;
        };
        let acceptor = acceptor.clone();
        let ctx = ctx.clone();
        tokio::spawn(async move {
            ctx.trace(format_args!("h2 connection from {peer}"));
            if let Err(e) = connection(tcp, acceptor, ctx.clone()).await {
                ctx.trace(format_args!("h2 connection ended: {e}"));
            }
        });
    }
}

async fn connection(
    tcp: tokio::net::TcpStream,
    acceptor: TlsAcceptor,
    ctx: Arc<Ctx>,
) -> Result<(), BoxError> {
    let _ = tcp.set_nodelay(true);
    let tls = acceptor.accept(tcp).await?;
    let mut conn = h2::server::Builder::new()
        .enable_connect_protocol()
        .handshake::<_, Bytes>(tls)
        .await?;
    while let Some(next) = conn.accept().await {
        let (req, respond) = next?;
        let ctx = ctx.clone();
        tokio::spawn(async move {
            if let Err(e) = request(req, respond, &ctx).await {
                ctx.trace(format_args!("h2 stream ended: {e}"));
            }
        });
    }
    Ok(())
}

async fn request(
    req: Request<RecvStream>,
    respond: SendResponse<Bytes>,
    ctx: &Ctx,
) -> Result<(), BoxError> {
    let protocol = req
        .extensions()
        .get::<Protocol>()
        .map(|p| p.as_str().to_string());
    ctx.trace(format_args!(
        "h2 {} {} protocol={:?} headers={:?}",
        req.method(),
        req.uri(),
        protocol,
        req.headers()
    ));
    match (req.method(), protocol.as_deref()) {
        (&Method::CONNECT, None) => tcp(req, respond, ctx).await,
        (&Method::CONNECT, Some("connect-udp")) => udp(req, respond, ctx).await,
        _ => reject(respond, StatusCode::NOT_IMPLEMENTED),
    }
}

fn reject(mut respond: SendResponse<Bytes>, status: StatusCode) -> Result<(), BoxError> {
    respond.send_response(Response::builder().status(status).body(())?, true)?;
    Ok(())
}

async fn tcp(
    req: Request<RecvStream>,
    mut respond: SendResponse<Bytes>,
    ctx: &Ctx,
) -> Result<(), BoxError> {
    let Some((host, port)) = req
        .uri()
        .authority()
        .and_then(|a| wire::parse_authority(a.as_str()))
    else {
        return reject(respond, StatusCode::BAD_REQUEST);
    };
    let target = match ctx.connect_tcp(&host, port).await {
        Ok(t) => t,
        Err(e) => {
            ctx.trace(format_args!("tcp {host}:{port}: {e}"));
            return reject(respond, StatusCode::BAD_GATEWAY);
        }
    };
    let mut send =
        respond.send_response(Response::builder().status(StatusCode::OK).body(())?, false)?;
    let mut recv = req.into_body();
    let (mut rd, mut wr) = target.into_split();
    let up = async {
        while let Some(chunk) = recv.data().await {
            let chunk = chunk?;
            let _ = recv.flow_control().release_capacity(chunk.len());
            wr.write_all(&chunk).await?;
        }
        wr.shutdown().await?;
        Ok::<_, BoxError>(())
    };
    let down = async {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            let n = rd.read(&mut buf).await?;
            if n == 0 {
                send.send_data(Bytes::new(), true)?;
                return Ok::<_, BoxError>(());
            }
            send_all(&mut send, Bytes::copy_from_slice(&buf[..n])).await?;
        }
    };
    tokio::try_join!(up, down)?;
    Ok(())
}

async fn udp(
    req: Request<RecvStream>,
    mut respond: SendResponse<Bytes>,
    ctx: &Ctx,
) -> Result<(), BoxError> {
    let Some((host, port)) = wire::parse_udp_path(req.uri().path()) else {
        return reject(respond, StatusCode::BAD_REQUEST);
    };
    let socket = match ctx.connect_udp(&host, port).await {
        Ok(s) => s,
        Err(e) => {
            ctx.trace(format_args!("udp {host}:{port}: {e}"));
            return reject(respond, StatusCode::BAD_GATEWAY);
        }
    };
    let mut send = respond.send_response(
        Response::builder()
            .status(StatusCode::OK)
            .header("capsule-protocol", "?1")
            .body(())?,
        false,
    )?;
    let mut recv = req.into_body();
    let up = async {
        let mut pending = BytesMut::new();
        while let Some(chunk) = recv.data().await {
            let chunk = chunk?;
            let _ = recv.flow_control().release_capacity(chunk.len());
            pending.extend_from_slice(&chunk);
            while let Some((kind, value)) = wire::take_capsule(&mut pending) {
                if kind != wire::CAPSULE_DATAGRAM {
                    continue;
                }
                if let Some(payload) = wire::udp_from_payload(value) {
                    let _ = socket.send(&payload).await;
                }
            }
        }
        Ok::<_, BoxError>(())
    };
    let down = async {
        let mut buf = vec![0u8; 65536];
        loop {
            match socket.recv(&mut buf).await {
                Ok(n) => send_all(&mut send, wire::datagram_capsule(&buf[..n])).await?,
                Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => {}
                Err(e) => return Err::<(), BoxError>(e.into()),
            }
        }
    };
    tokio::select! {
        r = up => r,
        r = down => r,
    }
}

/// HTTP/2 の送り先の窓（flow control）が空くのを待ちながら、全部を送る。
async fn send_all(send: &mut SendStream<Bytes>, mut data: Bytes) -> Result<(), BoxError> {
    while !data.is_empty() {
        send.reserve_capacity(data.len());
        let n = match std::future::poll_fn(|cx| send.poll_capacity(cx)).await {
            Some(n) => n?,
            None => return Err("h2 stream closed".into()),
        };
        if n == 0 {
            continue;
        }
        send.send_data(data.split_to(n.min(data.len())), false)?;
    }
    Ok(())
}
