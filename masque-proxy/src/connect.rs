//! 行き先へのつなぎ方。名前は DNS のサーバーへ自分で問い合わせ（getaddrinfo は使わない）、
//! IPv6 のアドレスに先につなぎ、つながらなければ IPv4 につなぐ。

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use hickory_resolver::config::{LookupIpStrategy, NameServerConfig, ResolverConfig};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::TokioResolver;
use tokio::net::{TcpStream, UdpSocket};

/// 1 つのアドレスへの TCP の接続を待つ長さ。過ぎたら次のアドレス（IPv6 の次は IPv4）に移る。
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// 行き先の名前を問い合わせる DNS のサーバー。
#[derive(Debug, Clone)]
pub enum Dns {
    /// OS に設定された DNS のサーバー（macOS は System Configuration の `State:/Network/Global/DNS`）。
    /// サーバーのアドレスを読むだけで、問い合わせはこの crate が自分で送る。
    System,
    /// 指定したサーバー（ポート 53、UDP と TCP）。
    Servers(Vec<IpAddr>),
}

pub(crate) struct Ctx {
    resolver: TokioResolver,
    pub(crate) log: bool,
}

impl Ctx {
    pub(crate) fn new(dns: &Dns, log: bool) -> io::Result<Ctx> {
        let mut builder = match dns {
            Dns::System => TokioResolver::builder_tokio().map_err(io::Error::other)?,
            Dns::Servers(ips) => {
                let servers = ips
                    .iter()
                    .map(|ip| NameServerConfig::udp_and_tcp(*ip))
                    .collect();
                TokioResolver::builder_with_config(
                    ResolverConfig::from_parts(None, vec![], servers),
                    TokioRuntimeProvider::default(),
                )
            }
        };
        // AAAA と A を並べて問い合わせ、AAAA を先に並べる
        builder.options_mut().ip_strategy = LookupIpStrategy::Ipv6AndIpv4;
        let resolver = builder.build().map_err(io::Error::other)?;
        Ok(Ctx { resolver, log })
    }

    /// 行き先のアドレスを、IPv6 を先にして返す。IP のリテラルなら問い合わせない。
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        if let Ok(ip) = host.parse::<IpAddr>() {
            return Ok(vec![SocketAddr::new(ip, port)]);
        }
        let lookup = self
            .resolver
            .lookup_ip(host)
            .await
            .map_err(|e| io::Error::new(io::ErrorKind::NotFound, e))?;
        let mut addrs: Vec<SocketAddr> =
            lookup.iter().map(|ip| SocketAddr::new(ip, port)).collect();
        // 並びは IPv6 が先（安定な並べ替えなので、同じ種類の中の順は DNS の答えのまま）
        addrs.sort_by_key(|a| a.is_ipv4());
        if addrs.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("{host}: no address"),
            ));
        }
        Ok(addrs)
    }

    /// 行き先に TCP でつなぐ。
    pub(crate) async fn connect_tcp(&self, host: &str, port: u16) -> io::Result<TcpStream> {
        let mut last = None;
        for addr in self.resolve(host, port).await? {
            match tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
                Ok(Ok(stream)) => {
                    self.trace(format_args!("tcp {host}:{port} -> {addr}"));
                    let _ = stream.set_nodelay(true);
                    return Ok(stream);
                }
                Ok(Err(e)) => last = Some(e),
                Err(_) => last = Some(io::Error::from(io::ErrorKind::TimedOut)),
            }
        }
        Err(last.unwrap_or_else(|| io::Error::from(io::ErrorKind::NotFound)))
    }

    /// 行き先に UDP のソケットを向ける（`connect` する）。経路の無いアドレスは飛ばす。
    pub(crate) async fn connect_udp(&self, host: &str, port: u16) -> io::Result<UdpSocket> {
        let mut last = None;
        for addr in self.resolve(host, port).await? {
            let local: SocketAddr = match addr {
                SocketAddr::V6(_) => (Ipv6Addr::UNSPECIFIED, 0).into(),
                SocketAddr::V4(_) => (Ipv4Addr::UNSPECIFIED, 0).into(),
            };
            let socket = match UdpSocket::bind(local).await {
                Ok(socket) => socket,
                Err(e) => {
                    last = Some(e);
                    continue;
                }
            };
            match socket.connect(addr).await {
                Ok(()) => {
                    self.trace(format_args!("udp {host}:{port} -> {addr}"));
                    return Ok(socket);
                }
                Err(e) => last = Some(e),
            }
        }
        Err(last.unwrap_or_else(|| io::Error::from(io::ErrorKind::NotFound)))
    }

    pub(crate) fn trace(&self, args: std::fmt::Arguments<'_>) {
        if self.log {
            eprintln!("masque-proxy: {args}");
        }
    }
}
