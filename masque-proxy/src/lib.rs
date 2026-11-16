//! 中継型（relay）のプロキシ。
//!
//! macOS の Network.framework の `nw_relay_hop_create` が話す相手として動く。
//! - HTTP/3（QUIC）と HTTP/2（TLS の上）で受ける。
//! - `CONNECT`（RFC 9114 4.4 / RFC 9113 8.5）で TCP の接続を運ぶ。
//! - `CONNECT` に `:protocol = connect-udp` を付けたもの（RFC 9298）で UDP を運ぶ。
//!   HTTP/3 では QUIC の DATAGRAM（RFC 9297）で、HTTP/2 では DATAGRAM の capsule で運ぶ。
//!
//! 行き先の名前は、`getaddrinfo` を使わずに DNS のサーバーへ自分で問い合わせて引き、
//! IPv6 のアドレスに先につなぐ（つながらなければ IPv4 につなぐ）。
//! macOS の名前解決が A レコードしか問い合わせない回線（IPv6 の無い回線の Cloudflare WARP など）でも、
//! IPv6 の出口を使うため（kisui-terminal の #287）。

mod connect;
mod h2_server;
mod h3_server;
mod tls;
mod wire;

use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::task::JoinHandle;

pub use connect::Dns;

/// プロキシの設定。
#[derive(Debug, Clone)]
pub struct Config {
    /// 待ち受ける IP。既定は 127.0.0.1（この機械の中の WebView にだけ使わせる）。
    pub listen_ip: IpAddr,
    /// HTTP/3（UDP）で待ち受けるポート。0 なら空いているものを使う。
    pub h3_port: u16,
    /// HTTP/2（TCP）で待ち受けるポート。0 なら空いているものを使う。
    pub h2_port: u16,
    /// 行き先の名前を問い合わせる DNS のサーバー。
    pub dns: Dns,
    /// 受けた CONNECT を標準エラーに出す（確かめるときのため）。
    pub log: bool,
    /// TLS の証明書と鍵のファイル（DER。`write_certificate` で作る）。None なら起動のたびに作る。
    pub identity_files: Option<(PathBuf, PathBuf)>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
            h3_port: 0,
            h2_port: 0,
            dns: Dns::System,
            log: false,
            identity_files: None,
        }
    }
}

/// `localhost`・`127.0.0.1`・`::1` の自己署名の証明書と鍵を作り、ファイル（DER）に書く。
/// 確かめるときに、同じ証明書でプロキシを何度も起動し、OS に信頼させるため。
pub fn write_certificate(cert: &Path, key: &Path) -> io::Result<()> {
    tls::Identity::generate(IpAddr::V4(Ipv4Addr::LOCALHOST))?.write(cert, key)
}

/// 動いているプロキシ。落とすと待ち受けを止める。
pub struct Proxy {
    h3_addr: SocketAddr,
    h2_addr: SocketAddr,
    certificate_der: Vec<u8>,
    tasks: Vec<JoinHandle<()>>,
}

impl Proxy {
    /// 待ち受けを始める。tokio の runtime の中で呼ぶ。
    pub async fn start(config: Config) -> io::Result<Proxy> {
        let identity = match &config.identity_files {
            Some((cert, key)) => tls::Identity::read(cert, key)?,
            None => tls::Identity::generate(config.listen_ip)?,
        };
        let ctx = Arc::new(connect::Ctx::new(&config.dns, config.log)?);

        let endpoint =
            h3_server::bind(SocketAddr::new(config.listen_ip, config.h3_port), &identity)?;
        let h3_addr = endpoint.local_addr()?;
        let listener =
            tokio::net::TcpListener::bind(SocketAddr::new(config.listen_ip, config.h2_port))
                .await?;
        let h2_addr = listener.local_addr()?;
        let acceptor = h2_server::acceptor(&identity)?;

        let tasks = vec![
            tokio::spawn(h3_server::serve(endpoint, ctx.clone())),
            tokio::spawn(h2_server::serve(listener, acceptor, ctx)),
        ];
        Ok(Proxy {
            h3_addr,
            h2_addr,
            certificate_der: identity.certificate_der,
            tasks,
        })
    }

    /// HTTP/3 で待ち受けている UDP のアドレス。
    pub fn h3_addr(&self) -> SocketAddr {
        self.h3_addr
    }

    /// HTTP/2 で待ち受けている TCP のアドレス。
    pub fn h2_addr(&self) -> SocketAddr {
        self.h2_addr
    }

    /// プロキシの TLS の証明書（自己署名、DER）。`Config::identity_files` を渡したときはそのファイルから
    /// 読んだもの、渡さなかったときは起動のたびに作ったもの。
    /// 使う側（`nw_relay_hop_create` の `relay_tls_options` の検証）は、この証明書と一致するかで信頼する。
    pub fn certificate_der(&self) -> &[u8] {
        &self.certificate_der
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}
