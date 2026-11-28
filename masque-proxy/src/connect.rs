//! 行き先へのつなぎ方。名前は DNS のサーバーへ自分で問い合わせ（getaddrinfo は使わない）、
//! IPv6 のアドレスに先につなぐ。
//!
//! TCP は Happy Eyeballs（RFC 8305）でつなぐ：IPv6 と IPv4 のアドレスを交互に並べ、IPv6 から始めて、
//! 前の試みが `CONNECTION_ATTEMPT_DELAY` のうちにつながらなければ（失敗したらすぐに）次のアドレスも並べて試し、
//! 先につながった方を使う。IPv6 が届く回線では IPv6 が先につながる。IPv6 の接続が返事も無く消える回線
//! （IPv6 のアドレスはあるが行き先まで届かない）でも、IPv6 のアドレスの数だけ待たずに IPv4 でつながる。
//!
//! UDP（CONNECT-UDP）には接続の確立が無く、経路さえあれば IPv6 への `connect` が成功するので、同じ回線では
//! 送ったものが全部消える。そこで、行き先の名前ごとに「TCP で IPv6 のアドレスも試したのに、IPv4 が先につながった」
//! ことを `IPV6_UNREACHABLE_TTL` の間だけ覚え（`Ipv6Unreachable`）、覚えている行き先には、UDP は IPv4 を先にし、
//! TCP も IPv4 から試す（RFC 8305 の 4 節の、前の結果を使う並べ方）。覚えた時刻が切れたら、TCP は IPv6 から
//! 試し直す。TCP で IPv6 が先につながったら忘れる。
//! ブラウザは、たいてい HTTP/3 を先に TCP で受けた応答（Alt-Svc）で知ってから使うので、UDP の前に同じ行き先の TCP が
//! ある。無いこともある（ブラウザが前に覚えた Alt-Svc を、このプロキシを起動し直したあとに使う・DNS の HTTPS
//! レコードで HTTP/3 を知る）。そのときは最初の HTTP/3 が届かず、ブラウザが TCP に戻ったときに覚える。

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use hickory_resolver::config::{LookupIpStrategy, NameServerConfig, ResolverConfig, ResolverOpts};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::proto::rr::Name;
use hickory_resolver::TokioResolver;
use tokio::net::{TcpStream, UdpSocket};
use tokio::task::JoinSet;

/// 1 つのアドレスへの TCP の接続を待つ長さ。過ぎたら、その試みはあきらめる。
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// TCP で、前の試みがつながらないまま、次のアドレスを試し始めるまでの長さ（RFC 8305 の Connection Attempt Delay の
/// 勧める値）。
const CONNECTION_ATTEMPT_DELAY: Duration = Duration::from_millis(250);
/// 行き先の名前ごとに、IPv6 が届かなかったことを覚える長さ。覚えている間は IPv4 から試し、その接続では覚え直さない
/// （覚えた時刻を延ばさない）。切れたら IPv6 から試し直し、また IPv4 に負けたら覚え直す。
const IPV6_UNREACHABLE_TTL: Duration = Duration::from_secs(10 * 60);
/// 覚える行き先の数の上限（覚えるだけ増えないように）。超えそうなら、切れたものを捨て、それでも多ければ全部忘れる。
const MAX_IPV6_UNREACHABLE: usize = 4096;
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
    ipv6_unreachable: Ipv6Unreachable,
    pub(crate) log: bool,
}

/// 行き先の名前ごとに、IPv6 が届かなかった（TCP で IPv6 のアドレスも試したのに、IPv4 が先につながった）時刻。
struct Ipv6Unreachable {
    ttl: Duration,
    max: usize,
    hosts: Mutex<HashMap<String, Instant>>,
}

impl Ipv6Unreachable {
    fn new(ttl: Duration, max: usize) -> Ipv6Unreachable {
        Ipv6Unreachable {
            ttl,
            max,
            hosts: Mutex::new(HashMap::new()),
        }
    }

    /// `host` には、今 IPv6 が届かないと覚えているか。
    fn contains(&self, host: &str, now: Instant) -> bool {
        let hosts = self.hosts.lock().unwrap_or_else(|e| e.into_inner());
        hosts
            .get(&host.to_ascii_lowercase())
            .is_some_and(|t| now.saturating_duration_since(*t) < self.ttl)
    }

    /// TCP でつながった結果を覚える。`ipv6_first` はその接続を IPv6 から試したか、`tried` は並べたアドレス、
    /// `winner` は先につながったアドレス。
    fn record(
        &self,
        host: &str,
        ipv6_first: bool,
        tried: &[SocketAddr],
        winner: SocketAddr,
        now: Instant,
    ) {
        let host = host.to_ascii_lowercase();
        let mut hosts = self.hosts.lock().unwrap_or_else(|e| e.into_inner());
        if winner.is_ipv6() {
            hosts.remove(&host);
            return;
        }
        // IPv4 から試した接続は、IPv6 を試す前につながっただけなので、IPv6 が届かない証しにならない。覚え直すと、
        // よく開く行き先はいつまでも IPv6 から試し直さなくなる
        if !ipv6_first || !tried.iter().any(|a| a.is_ipv6()) {
            return;
        }
        if hosts.len() >= self.max && !hosts.contains_key(&host) {
            let ttl = self.ttl;
            hosts.retain(|_, t| now.saturating_duration_since(*t) < ttl);
            if hosts.len() >= self.max {
                hosts.clear();
            }
        }
        hosts.insert(host, now);
    }
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
        Ok(Ctx {
            resolver,
            ipv6_unreachable: Ipv6Unreachable::new(IPV6_UNREACHABLE_TTL, MAX_IPV6_UNREACHABLE),
            log,
        })
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

    /// 行き先に TCP でつなぐ（Happy Eyeballs。モジュールの説明を見る）。
    pub(crate) async fn connect_tcp(&self, host: &str, port: u16) -> io::Result<TcpStream> {
        let ipv6_first = !self.ipv6_unreachable.contains(host, Instant::now());
        let addrs = interleave(self.resolve(host, port).await?, ipv6_first);
        let (stream, addr) = race(
            &addrs,
            CONNECTION_ATTEMPT_DELAY,
            TCP_CONNECT_TIMEOUT,
            TcpStream::connect,
        )
        .await?;
        self.ipv6_unreachable
            .record(host, ipv6_first, &addrs, addr, Instant::now());
        self.trace(format_args!("tcp {host}:{port} -> {addr}"));
        let _ = stream.set_nodelay(true);
        Ok(stream)
    }

    /// 行き先に UDP のソケットを向ける（`connect` する）。経路の無いアドレスは飛ばす。
    /// IPv6 が届かないと覚えている行き先（モジュールの説明を見る）には、IPv4 を先にする。
    pub(crate) async fn connect_udp(&self, host: &str, port: u16) -> io::Result<UdpSocket> {
        let mut addrs = self.resolve(host, port).await?;
        if self.ipv6_unreachable.contains(host, Instant::now()) {
            prefer_ipv4(&mut addrs);
        }
        let mut last = None;
        for addr in addrs {
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

/// IPv4 のアドレスを先に並べる。同じ種類の中の順は、渡された順のまま（安定な並べ替え）。
fn prefer_ipv4(addrs: &mut [SocketAddr]) {
    addrs.sort_by_key(|a| a.is_ipv6());
}

/// IPv6 と IPv4 のアドレスを交互に並べる（RFC 8305 の 4 節）。`ipv6_first` なら IPv6 から、でなければ IPv4 から。
/// 片方を使い切ったら、残りをそのまま並べる。同じ種類の中の順は、渡された順のまま。
fn interleave(addrs: Vec<SocketAddr>, ipv6_first: bool) -> Vec<SocketAddr> {
    let (v6, v4): (Vec<SocketAddr>, Vec<SocketAddr>) = addrs.into_iter().partition(|a| a.is_ipv6());
    let (first, second) = if ipv6_first { (v6, v4) } else { (v4, v6) };
    let mut out = Vec::with_capacity(first.len() + second.len());
    let (mut first, mut second) = (first.into_iter(), second.into_iter());
    loop {
        match (first.next(), second.next()) {
            (None, None) => return out,
            (a, b) => out.extend(a.into_iter().chain(b)),
        }
    }
}

/// `addrs` に順に `connect` を試し、先につながったものとそのアドレスを返す。前の試みが `delay` のうちに終わらなければ、
/// 待たずに次も試し始める（失敗したら、すぐに次を試す）。1 つの試みは `timeout` であきらめる。
/// 返すとき、まだ終わっていない試みは打ち切る。どれもつながらなければ、最後の誤りを返す。
async fn race<T, F, Fut>(
    addrs: &[SocketAddr],
    delay: Duration,
    timeout: Duration,
    connect: F,
) -> io::Result<(T, SocketAddr)>
where
    T: Send + 'static,
    F: Fn(SocketAddr) -> Fut,
    Fut: std::future::Future<Output = io::Result<T>> + Send + 'static,
{
    let mut attempts = JoinSet::new();
    let mut next = 0;
    let mut last = None;
    loop {
        if let Some(&addr) = addrs.get(next) {
            next += 1;
            let attempt = connect(addr);
            attempts.spawn(async move { (addr, tokio::time::timeout(timeout, attempt).await) });
        }
        if attempts.is_empty() {
            return Err(last.unwrap_or_else(|| io::Error::from(io::ErrorKind::NotFound)));
        }
        // 試みのどれかが終わるか、次を試し始める時が来るまで待つ。試すアドレスが残っていなければ、終わるのだけを待つ
        let more = next < addrs.len();
        tokio::select! {
            Some(done) = attempts.join_next() => match done {
                Ok((addr, Ok(Ok(v)))) => return Ok((v, addr)),
                Ok((_, Ok(Err(e)))) => last = Some(e),
                Ok((_, Err(_))) => last = Some(io::Error::from(io::ErrorKind::TimedOut)),
                Err(e) => last = Some(io::Error::other(e)),
            },
            _ = tokio::time::sleep(delay), if more => {}
        }
    }
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

    fn addrs(list: &[&str]) -> Vec<SocketAddr> {
        list.iter().map(|a| a.parse().unwrap()).collect()
    }

    #[test]
    fn interleaves_starting_with_ipv6() {
        let got = interleave(
            addrs(&[
                "192.0.2.1:443",
                "[2001:db8::1]:443",
                "[2001:db8::2]:443",
                "[2001:db8::3]:443",
                "192.0.2.2:443",
            ]),
            true,
        );
        assert_eq!(
            got,
            addrs(&[
                "[2001:db8::1]:443",
                "192.0.2.1:443",
                "[2001:db8::2]:443",
                "192.0.2.2:443",
                "[2001:db8::3]:443",
            ])
        );
        assert_eq!(
            interleave(addrs(&["192.0.2.1:443", "192.0.2.2:443"]), true),
            addrs(&["192.0.2.1:443", "192.0.2.2:443"])
        );
        assert!(interleave(vec![], true).is_empty());
        // IPv6 が届かないと覚えている行き先は、IPv4 から
        assert_eq!(
            interleave(
                addrs(&["[2001:db8::1]:443", "[2001:db8::2]:443", "192.0.2.1:443"]),
                false
            ),
            addrs(&["192.0.2.1:443", "[2001:db8::1]:443", "[2001:db8::2]:443"])
        );
    }

    type Attempt =
        std::pin::Pin<Box<dyn std::future::Future<Output = io::Result<SocketAddr>> + Send>>;

    /// IPv6 は返事が無い（いつまでも終わらない）、IPv4 はすぐにつながる回線。
    fn ipv6_black_hole(addr: SocketAddr) -> Attempt {
        Box::pin(async move {
            if addr.is_ipv6() {
                std::future::pending::<()>().await;
            }
            Ok(addr)
        })
    }

    #[tokio::test]
    async fn ipv4_wins_when_ipv6_never_answers() {
        // IPv6 のアドレスがいくつあっても、1 つ目の IPv6 の次に IPv4 を試す。各試みの待ちの長さまでは待たない
        let list = interleave(
            addrs(&[
                "[2001:db8::1]:443",
                "[2001:db8::2]:443",
                "[2001:db8::3]:443",
                "[2001:db8::4]:443",
                "192.0.2.1:443",
            ]),
            true,
        );
        let t0 = Instant::now();
        let (got, addr) = race(
            &list,
            Duration::from_millis(50),
            Duration::from_secs(30),
            ipv6_black_hole,
        )
        .await
        .unwrap();
        assert_eq!(got, addr);
        assert_eq!(addr, "192.0.2.1:443".parse().unwrap());
        assert!(t0.elapsed() < Duration::from_secs(5), "{:?}", t0.elapsed());
    }

    #[tokio::test]
    async fn ipv6_wins_when_it_answers_in_time() {
        // IPv6 が `delay` より短い時間でつながれば、すぐにつながる IPv4 も試し始めない
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let list = interleave(addrs(&["192.0.2.1:443", "[2001:db8::1]:443"]), true);
        let ipv4_tried = Arc::new(AtomicUsize::new(0));
        let counter = ipv4_tried.clone();
        let (_, addr) = race(
            &list,
            Duration::from_millis(200),
            Duration::from_secs(30),
            move |a: SocketAddr| -> Attempt {
                let counter = counter.clone();
                Box::pin(async move {
                    if a.is_ipv6() {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    } else {
                        counter.fetch_add(1, Ordering::SeqCst);
                    }
                    Ok(a)
                })
            },
        )
        .await
        .unwrap();
        assert_eq!(addr, "[2001:db8::1]:443".parse().unwrap());
        assert_eq!(ipv4_tried.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_failure_starts_the_next_at_once() {
        // 待つ長さが長くても、失敗したらすぐに次を試す
        let list = addrs(&["[2001:db8::1]:443", "192.0.2.1:443"]);
        let t0 = Instant::now();
        let (_, addr) = race(
            &list,
            Duration::from_secs(30),
            Duration::from_secs(30),
            |a: SocketAddr| -> Attempt {
                Box::pin(async move {
                    if a.is_ipv6() {
                        Err(io::Error::from(io::ErrorKind::ConnectionRefused))
                    } else {
                        Ok(a)
                    }
                })
            },
        )
        .await
        .unwrap();
        assert_eq!(addr, "192.0.2.1:443".parse().unwrap());
        assert!(t0.elapsed() < Duration::from_secs(5), "{:?}", t0.elapsed());
    }

    #[tokio::test]
    async fn the_last_error_is_returned_when_none_connects() {
        let list = addrs(&["[2001:db8::1]:443", "192.0.2.1:443"]);
        let err = race(
            &list,
            Duration::from_millis(10),
            Duration::from_millis(50),
            |a: SocketAddr| -> Attempt {
                Box::pin(async move {
                    if a.is_ipv6() {
                        std::future::pending::<()>().await;
                    }
                    Err(io::Error::from(io::ErrorKind::ConnectionRefused))
                })
            },
        )
        .await
        .unwrap_err();
        // IPv4 が先に断られ、IPv6 があとで待ち切れになる
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(race(
            &[],
            Duration::from_millis(10),
            Duration::from_millis(10),
            ipv6_black_hole
        )
        .await
        .is_err());
    }

    #[test]
    fn remembers_hosts_whose_ipv6_did_not_answer() {
        let m = Ipv6Unreachable::new(Duration::from_secs(600), 4096);
        let t0 = Instant::now();
        let both = addrs(&["[2001:db8::1]:443", "192.0.2.1:443"]);
        let v4 = "192.0.2.1:443".parse().unwrap();
        let v6 = "[2001:db8::1]:443".parse().unwrap();
        assert!(!m.contains("example.com", t0));

        // IPv6 も試したのに IPv4 が先につながったら覚える（名前の大文字小文字は区別しない）
        m.record("Example.com", true, &both, v4, t0);
        assert!(m.contains("example.com", t0 + Duration::from_secs(1)));
        assert!(!m.contains("other.example", t0));
        // 覚える長さを過ぎたら忘れる
        assert!(!m.contains("example.com", t0 + Duration::from_secs(600)));

        // IPv6 が先につながったら忘れる
        m.record("example.com", true, &both, v4, t0);
        m.record("example.com", true, &both, v6, t0);
        assert!(!m.contains("example.com", t0));

        // IPv4 から試して IPv4 がつながっても、覚えた時刻は延びない（切れたら IPv6 から試し直す）
        m.record("example.com", true, &both, v4, t0);
        m.record(
            "example.com",
            false,
            &both,
            v4,
            t0 + Duration::from_secs(300),
        );
        assert!(!m.contains("example.com", t0 + Duration::from_secs(600)));
        // 忘れたあとに IPv4 から試しても、覚えない
        m.record("fresh.example", false, &both, v4, t0);
        assert!(!m.contains("fresh.example", t0));

        // IPv6 のアドレスが無かった（IPv4 しか試していない）なら覚えない
        m.record("v4only.example", true, &addrs(&["192.0.2.1:443"]), v4, t0);
        assert!(!m.contains("v4only.example", t0));
    }

    #[test]
    fn remembered_hosts_are_bounded() {
        let m = Ipv6Unreachable::new(Duration::from_secs(600), 2);
        let t0 = Instant::now();
        let both = addrs(&["[2001:db8::1]:443", "192.0.2.1:443"]);
        let v4 = "192.0.2.1:443".parse().unwrap();
        m.record("a.example", true, &both, v4, t0);
        m.record("b.example", true, &both, v4, t0 + Duration::from_secs(1));
        // いっぱいで、切れたものも無ければ全部忘れてから覚える
        m.record("c.example", true, &both, v4, t0 + Duration::from_secs(2));
        assert!(!m.contains("a.example", t0 + Duration::from_secs(2)));
        assert!(m.contains("c.example", t0 + Duration::from_secs(2)));
        // 切れたものがあれば、それだけ捨てる
        m.record("d.example", true, &both, v4, t0 + Duration::from_secs(3));
        m.record("e.example", true, &both, v4, t0 + Duration::from_secs(602));
        assert!(m.contains("d.example", t0 + Duration::from_secs(602)));
        assert!(m.contains("e.example", t0 + Duration::from_secs(602)));
        assert!(!m.contains("c.example", t0 + Duration::from_secs(602)));
    }

    #[test]
    fn ipv4_first_keeps_the_order_within_a_family() {
        let mut list = addrs(&[
            "[2001:db8::1]:443",
            "192.0.2.1:443",
            "[2001:db8::2]:443",
            "192.0.2.2:443",
        ]);
        prefer_ipv4(&mut list);
        assert_eq!(
            list,
            addrs(&[
                "192.0.2.1:443",
                "192.0.2.2:443",
                "[2001:db8::1]:443",
                "[2001:db8::2]:443",
            ])
        );
    }
}
