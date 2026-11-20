//! 行き先へのつなぎ方。名前は DNS のサーバーへ自分で問い合わせ（getaddrinfo は使わない）、
//! IPv6 のアドレスに先につなぎ、つながらなければ IPv4 につなぐ。

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use hickory_resolver::config::{LookupIpStrategy, NameServerConfig, ResolverConfig, ResolverOpts};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::proto::rr::Name;
use hickory_resolver::TokioResolver;
use tokio::net::{TcpStream, UdpSocket};

/// 1 つのアドレスへの TCP の接続を待つ長さ。過ぎたら次のアドレス（IPv6 の次は IPv4）に移る。
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// `Dns::System` で、OS に設定された DNS のサーバーを読み直す間隔。回線が変わる（Wi-Fi を移る・WARP を入れ切りする）と
/// サーバーも変わるので、起動のときに 1 度読むだけにはしない。
const SYSTEM_DNS_RECHECK: Duration = Duration::from_secs(5);

/// 行き先の名前を問い合わせる DNS のサーバー。
#[derive(Debug, Clone)]
pub enum Dns {
    /// OS に設定された DNS のサーバー（macOS は System Configuration の `State:/Network/Global/DNS`）。
    /// サーバーのアドレスを読むだけで、問い合わせはこの crate が自分で送る。
    /// 問い合わせる前に（5 秒に 1 度まで）読み直し、変わっていたら新しいサーバーに問い合わせる。
    /// 起動のときに設定が無くても（回線につながっていない）起動はでき、設定が出てから問い合わせる。
    System,
    /// 指定したサーバー（ポート 53、UDP と TCP）。
    Servers(Vec<IpAddr>),
}

pub(crate) struct Ctx {
    resolver: Resolvers,
    pub(crate) log: bool,
}

enum Resolvers {
    /// 決めたサーバー（`Dns::Servers`）
    Fixed(TokioResolver),
    /// OS に設定されたサーバー（`Dns::System`）
    System(SystemResolver),
}

/// OS の DNS の設定を読む関数（テストでは差し替える）。
type ReadConf = fn() -> io::Result<(ResolverConfig, ResolverOpts)>;

fn read_system_conf() -> io::Result<(ResolverConfig, ResolverOpts)> {
    hickory_resolver::system_conf::read_system_conf().map_err(io::Error::other)
}

/// OS に設定された DNS のサーバーに問い合わせる resolver。設定が変わったら作り直す。
struct SystemResolver {
    read: ReadConf,
    recheck: Duration,
    state: Mutex<SystemState>,
}

#[derive(Default)]
struct SystemState {
    /// 今の設定（サーバーのアドレスと search のドメイン）と、それで作った resolver
    current: Option<(SystemKey, TokioResolver)>,
    /// 最後に設定を読んだ時刻
    checked: Option<Instant>,
}

type SystemKey = (Vec<IpAddr>, Vec<Name>);

impl SystemResolver {
    fn new(read: ReadConf, recheck: Duration) -> SystemResolver {
        SystemResolver {
            read,
            recheck,
            state: Mutex::new(SystemState::default()),
        }
    }

    /// 今使う resolver。読み直す時が来ていれば設定を読み、変わっていれば作り直す。
    /// 読めなかったときは、前の resolver を使い続ける（前が無ければ失敗）。
    fn get(&self, now: Instant) -> io::Result<TokioResolver> {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let due = st.current.is_none()
            || st
                .checked
                .is_none_or(|t| now.saturating_duration_since(t) >= self.recheck);
        if due {
            st.checked = Some(now);
            match (self.read)() {
                Ok((config, opts)) => {
                    let key: SystemKey = (
                        config.name_servers().iter().map(|s| s.ip).collect(),
                        config.search().to_vec(),
                    );
                    if st.current.as_ref().map(|(k, _)| k) != Some(&key) {
                        let resolver = build_resolver(config, opts)?;
                        st.current = Some((key, resolver));
                    }
                }
                Err(e) if st.current.is_none() => return Err(e),
                Err(_) => {}
            }
        }
        match &st.current {
            Some((_, resolver)) => Ok(resolver.clone()),
            None => Err(io::Error::from(io::ErrorKind::NotFound)),
        }
    }
}

/// 設定から resolver を作る。AAAA と A を並べて問い合わせ、AAAA を先に並べる。
fn build_resolver(config: ResolverConfig, opts: ResolverOpts) -> io::Result<TokioResolver> {
    let mut builder = TokioResolver::builder_with_config(config, TokioRuntimeProvider::default());
    *builder.options_mut() = opts;
    builder.options_mut().ip_strategy = LookupIpStrategy::Ipv6AndIpv4;
    builder.build().map_err(io::Error::other)
}

impl Ctx {
    pub(crate) fn new(dns: &Dns, log: bool) -> io::Result<Ctx> {
        let resolver = match dns {
            Dns::System => {
                Resolvers::System(SystemResolver::new(read_system_conf, SYSTEM_DNS_RECHECK))
            }
            Dns::Servers(ips) => {
                let servers = ips
                    .iter()
                    .map(|ip| NameServerConfig::udp_and_tcp(*ip))
                    .collect();
                Resolvers::Fixed(build_resolver(
                    ResolverConfig::from_parts(None, vec![], servers),
                    ResolverOpts::default(),
                )?)
            }
        };
        Ok(Ctx { resolver, log })
    }

    fn resolver(&self) -> io::Result<TokioResolver> {
        match &self.resolver {
            Resolvers::Fixed(r) => Ok(r.clone()),
            Resolvers::System(s) => s.get(Instant::now()),
        }
    }

    /// 行き先のアドレスを、IPv6 を先にして返す。IP のリテラルなら問い合わせない。
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        if let Ok(ip) = host.parse::<IpAddr>() {
            return Ok(vec![SocketAddr::new(ip, port)]);
        }
        let lookup = self
            .resolver()?
            .lookup_ip(host)
            .await
            .map_err(|e| io::Error::new(io::ErrorKind::NotFound, e))?;
        let mut addrs: Vec<SocketAddr> =
            lookup.iter().map(|ip| SocketAddr::new(ip, port)).collect();
        prefer_ipv6(&mut addrs);
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

/// IPv6 のアドレスを先に並べる。同じ種類の中の順は、DNS の答えのまま（安定な並べ替え）。
fn prefer_ipv6(addrs: &mut [SocketAddr]) {
    addrs.sort_by_key(|a| a.is_ipv4());
}

#[cfg(test)]
mod tests {
    use super::*;

    static SERVERS: Mutex<Vec<IpAddr>> = Mutex::new(Vec::new());

    fn fake_conf() -> io::Result<(ResolverConfig, ResolverOpts)> {
        let ips = SERVERS.lock().unwrap().clone();
        if ips.is_empty() {
            return Err(io::Error::from(io::ErrorKind::NotFound));
        }
        let servers = ips.into_iter().map(NameServerConfig::udp_and_tcp).collect();
        Ok((
            ResolverConfig::from_parts(None, vec![], servers),
            ResolverOpts::default(),
        ))
    }

    fn servers_of(r: &SystemResolver) -> Vec<IpAddr> {
        let st = r.state.lock().unwrap();
        st.current
            .as_ref()
            .map(|(k, _)| k.0.clone())
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn system_dns_follows_the_os_settings() {
        let r = SystemResolver::new(fake_conf, Duration::from_secs(5));
        let t0 = Instant::now();
        // 回線が無い（設定が無い）間は失敗するが、起動はできる
        assert!(r.get(t0).is_err());

        let a: IpAddr = "192.0.2.53".parse().unwrap();
        let b: IpAddr = "127.0.2.2".parse().unwrap();
        *SERVERS.lock().unwrap() = vec![a];
        r.get(t0).unwrap();
        assert_eq!(servers_of(&r), [a]);

        // 間隔の内は読み直さない
        *SERVERS.lock().unwrap() = vec![b];
        r.get(t0 + Duration::from_secs(1)).unwrap();
        assert_eq!(servers_of(&r), [a]);

        // 間隔が過ぎたら読み直し、変わったサーバーを使う
        r.get(t0 + Duration::from_secs(6)).unwrap();
        assert_eq!(servers_of(&r), [b]);

        // 読めなくなっても、前のサーバーを使い続ける
        SERVERS.lock().unwrap().clear();
        r.get(t0 + Duration::from_secs(12)).unwrap();
        assert_eq!(servers_of(&r), [b]);
    }

    #[test]
    fn ipv6_comes_first_keeping_dns_order() {
        let mut addrs: Vec<SocketAddr> = [
            "192.0.2.1:443",
            "[2001:db8::2]:443",
            "192.0.2.2:443",
            "[2001:db8::1]:443",
        ]
        .iter()
        .map(|a| a.parse().unwrap())
        .collect();
        prefer_ipv6(&mut addrs);
        let got: Vec<String> = addrs.iter().map(|a| a.to_string()).collect();
        assert_eq!(
            got,
            [
                "[2001:db8::2]:443",
                "[2001:db8::1]:443",
                "192.0.2.1:443",
                "192.0.2.2:443"
            ]
        );
    }
}
