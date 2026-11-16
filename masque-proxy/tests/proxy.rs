//! プロキシを通して、手元に立てた TCP と UDP のサーバーにつながることを確かめる。
//! 行き先は IP のリテラル（127.0.0.1）なので、DNS にも外の回線にも依らない（WARP の無い CI でも通る）。

use std::future::poll_fn;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use bytes::{Buf, BufMut, Bytes, BytesMut};
use http::{Method, Request, StatusCode};
use masque_proxy::{Config, Dns, Proxy};
use tokio::net::{TcpListener, UdpSocket};
use tokio::time::timeout;

const WAIT: Duration = Duration::from_secs(10);

async fn start_proxy() -> Proxy {
    Proxy::start(Config {
        // 行き先は IP のリテラルだけなので、問い合わせは送らない
        dns: Dns::Servers(vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]),
        ..Config::default()
    })
    .await
    .expect("start proxy")
}

/// 受けたものをそのまま返す TCP のサーバー。
async fn tcp_echo() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut rd, mut wr) = stream.split();
                let _ = tokio::io::copy(&mut rd, &mut wr).await;
            });
        }
    });
    addr
}

/// 受けたものの頭に "echo:" を付けて返す UDP のサーバー。
async fn udp_echo() -> SocketAddr {
    let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let addr = socket.local_addr().unwrap();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 65536];
        while let Ok((n, from)) = socket.recv_from(&mut buf).await {
            let mut reply = b"echo:".to_vec();
            reply.extend_from_slice(&buf[..n]);
            let _ = socket.send_to(&reply, from).await;
        }
    });
    addr
}

fn client_tls(proxy: &Proxy, alpn: &[u8]) -> rustls::ClientConfig {
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls::pki_types::CertificateDer::from(
            proxy.certificate_der().to_vec(),
        ))
        .unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![alpn.to_vec()];
    config
}

fn put_varint(buf: &mut BytesMut, v: u64) {
    if v < 1 << 6 {
        buf.put_u8(v as u8);
    } else if v < 1 << 14 {
        buf.put_u16(0x4000 | v as u16);
    } else {
        buf.put_u32(0x8000_0000 | v as u32);
    }
}

fn get_varint(buf: &mut Bytes) -> u64 {
    let len = 1usize << (buf[0] >> 6);
    let mut v = (buf.get_u8() & 0x3f) as u64;
    for _ in 1..len {
        v = (v << 8) | buf.get_u8() as u64;
    }
    v
}

fn udp_path(target: SocketAddr) -> String {
    format!(
        "https://localhost/.well-known/masque/udp/{}/{}/",
        target.ip(),
        target.port()
    )
}

async fn h3_connect(
    proxy: &Proxy,
) -> (
    quinn::Connection,
    h3::client::SendRequest<h3_quinn::OpenStreams, Bytes>,
    quinn::Endpoint,
) {
    let crypto =
        quinn::crypto::rustls::QuicClientConfig::try_from(client_tls(proxy, b"h3")).unwrap();
    let mut endpoint = quinn::Endpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
    endpoint.set_default_client_config(quinn::ClientConfig::new(Arc::new(crypto)));
    let conn = endpoint
        .connect(proxy.h3_addr(), "localhost")
        .unwrap()
        .await
        .unwrap();
    let (mut driver, send) = h3::client::builder()
        .enable_extended_connect(true)
        .enable_datagram(true)
        .build::<_, _, Bytes>(h3_quinn::Connection::new(conn.clone()))
        .await
        .unwrap();
    tokio::spawn(async move { poll_fn(|cx| driver.poll_close(cx)).await });
    (conn, send, endpoint)
}

#[tokio::test]
async fn h3_carries_tcp() {
    let proxy = start_proxy().await;
    let target = tcp_echo().await;
    let (_conn, mut send, _endpoint) = h3_connect(&proxy).await;

    let req = Request::builder()
        .method(Method::CONNECT)
        .uri(target.to_string())
        .body(())
        .unwrap();
    let mut stream = timeout(WAIT, send.send_request(req))
        .await
        .unwrap()
        .unwrap();
    let resp = timeout(WAIT, stream.recv_response())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    stream
        .send_data(Bytes::from_static(b"hello over h3"))
        .await
        .unwrap();
    let mut got = Vec::new();
    while got.len() < b"hello over h3".len() {
        let mut chunk = timeout(WAIT, stream.recv_data())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        got.extend_from_slice(&chunk.copy_to_bytes(chunk.remaining()));
    }
    assert_eq!(got, b"hello over h3");
}

#[tokio::test]
async fn h3_carries_udp_including_datagrams_sent_before_the_response() {
    let proxy = start_proxy().await;
    let target = udp_echo().await;
    let (conn, mut send, _endpoint) = h3_connect(&proxy).await;

    let mut req = Request::builder()
        .method(Method::CONNECT)
        .uri(udp_path(target))
        .header("capsule-protocol", "?1")
        .body(())
        .unwrap();
    req.extensions_mut().insert(h3::ext::Protocol::CONNECT_UDP);
    let mut stream = timeout(WAIT, send.send_request(req))
        .await
        .unwrap()
        .unwrap();
    let quarter_id = stream.id().into_inner() / 4;
    let datagram = |payload: &[u8]| {
        let mut buf = BytesMut::new();
        put_varint(&mut buf, quarter_id);
        put_varint(&mut buf, 0);
        buf.put_slice(payload);
        buf.freeze()
    };

    // macOS と同じく、返事を待たずに最初の datagram を送る（プロキシが流れを始めるまで溜めておく）
    conn.send_datagram(datagram(b"early")).unwrap();
    let resp = timeout(WAIT, stream.recv_response())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    conn.send_datagram(datagram(b"late")).unwrap();

    let mut got = Vec::new();
    while got.len() < 2 {
        let mut reply = timeout(WAIT, conn.read_datagram()).await.unwrap().unwrap();
        assert_eq!(get_varint(&mut reply), quarter_id);
        assert_eq!(get_varint(&mut reply), 0);
        got.push(reply);
    }
    got.sort();
    assert_eq!(
        got,
        vec![
            Bytes::from_static(b"echo:early"),
            Bytes::from_static(b"echo:late")
        ]
    );
}

async fn h2_connect(proxy: &Proxy) -> h2::client::SendRequest<Bytes> {
    let connector = tokio_rustls::TlsConnector::from(Arc::new(client_tls(proxy, b"h2")));
    let tcp = tokio::net::TcpStream::connect(proxy.h2_addr())
        .await
        .unwrap();
    let tls = connector
        .connect("localhost".try_into().unwrap(), tcp)
        .await
        .unwrap();
    let (send, conn) = h2::client::handshake(tls).await.unwrap();
    tokio::spawn(conn);
    send.ready().await.unwrap()
}

#[tokio::test]
async fn h2_carries_tcp() {
    let proxy = start_proxy().await;
    let target = tcp_echo().await;
    let mut send = h2_connect(&proxy).await;

    let req = Request::builder()
        .method(Method::CONNECT)
        .uri(target.to_string())
        .body(())
        .unwrap();
    let (resp, mut body_out) = send.send_request(req, false).unwrap();
    let resp = timeout(WAIT, resp).await.unwrap().unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    body_out
        .send_data(Bytes::from_static(b"hello over h2"), false)
        .unwrap();
    let mut body_in = resp.into_body();
    let mut got = Vec::new();
    while got.len() < b"hello over h2".len() {
        let chunk = timeout(WAIT, body_in.data())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let _ = body_in.flow_control().release_capacity(chunk.len());
        got.extend_from_slice(&chunk);
    }
    assert_eq!(got, b"hello over h2");
}

#[tokio::test]
async fn h2_carries_udp_in_capsules() {
    let proxy = start_proxy().await;
    let target = udp_echo().await;
    let mut send = h2_connect(&proxy).await;
    // 拡張の CONNECT は、プロキシの SETTINGS が届いてから使える
    for _ in 0..100 {
        if send.is_extended_connect_protocol_enabled() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        send = send.ready().await.unwrap();
    }
    assert!(send.is_extended_connect_protocol_enabled());

    let mut req = Request::builder()
        .method(Method::CONNECT)
        .uri(udp_path(target))
        .header("capsule-protocol", "?1")
        .body(())
        .unwrap();
    req.extensions_mut()
        .insert(h2::ext::Protocol::from("connect-udp"));
    let (resp, mut body_out) = send.send_request(req, false).unwrap();
    let resp = timeout(WAIT, resp).await.unwrap().unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // DATAGRAM の capsule（種類 0、長さ、文脈 ID 0、中身）
    let mut capsule = BytesMut::new();
    put_varint(&mut capsule, 0);
    put_varint(&mut capsule, 1 + 5);
    put_varint(&mut capsule, 0);
    capsule.put_slice(b"hello");
    body_out.send_data(capsule.freeze(), false).unwrap();

    let mut body_in = resp.into_body();
    let mut got = BytesMut::new();
    let want = 2 + 1 + b"echo:hello".len();
    while got.len() < want {
        let chunk = timeout(WAIT, body_in.data())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let _ = body_in.flow_control().release_capacity(chunk.len());
        got.extend_from_slice(&chunk);
    }
    let mut got = got.freeze();
    assert_eq!(get_varint(&mut got), 0);
    assert_eq!(get_varint(&mut got) as usize, 1 + b"echo:hello".len());
    assert_eq!(get_varint(&mut got), 0);
    assert_eq!(got, Bytes::from_static(b"echo:hello"));
}

#[tokio::test]
async fn h2_closes_udp_stream_on_too_long_capsule() {
    let proxy = start_proxy().await;
    let target = udp_echo().await;
    let mut send = h2_connect(&proxy).await;
    for _ in 0..100 {
        if send.is_extended_connect_protocol_enabled() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        send = send.ready().await.unwrap();
    }

    let mut req = Request::builder()
        .method(Method::CONNECT)
        .uri(udp_path(target))
        .header("capsule-protocol", "?1")
        .body(())
        .unwrap();
    req.extensions_mut()
        .insert(h2::ext::Protocol::from("connect-udp"));
    let (resp, mut body_out) = send.send_request(req, false).unwrap();
    let resp = timeout(WAIT, resp).await.unwrap().unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // 長さに 2^29 を書いた capsule の頭と、上限を超える分の中身（全部は届かない）
    let mut capsule = BytesMut::new();
    put_varint(&mut capsule, 0);
    put_varint(&mut capsule, 1 << 29);
    capsule.put_slice(&vec![0u8; 70_000]);
    body_out.send_data(capsule.freeze(), false).unwrap();

    // プロキシは溜め続けずに stream を閉じる
    let mut body_in = resp.into_body();
    match timeout(WAIT, body_in.data()).await.unwrap() {
        None | Some(Err(_)) => {}
        Some(Ok(data)) => panic!("unexpected data: {data:?}"),
    }
}
