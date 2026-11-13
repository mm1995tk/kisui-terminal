//! `kisui relay` の窓の側（#127。取り決めは docs/design/relay.md）。
//!
//! リモートのマシンで `ssh <マシン> -- <kisui> relay` を起こし、その標準入出力の上の枠（フレーム）で、手元のブラウザの
//! TCP 接続をリモートのマシンの loopback のポートへ中継する。ssh のポート転送（`ssh -L`）を使わないので、ポート転送を
//! 断る中継（Cloudflare Access for Infrastructure など）や `AllowTcpForwarding no` の sshd でも使える。
//!
//! 1 本の [`Relay`] の上に、ブラウザの接続を何本でも通す。接続ごとに、ブラウザから読む糸（[`Relay::pipe`] を呼んだ糸）と
//! ブラウザへ書く糸を持ち、`kisui relay` から読む糸（[`Relay::start`] が起こす 1 本）が枠を振り分ける。
//!
//! 流量の制御は取り決めのとおり、接続ごと・向きごとに 256 KiB の窓。ブラウザ → relay の向きは、ACK されていない分が
//! 窓を超えるならブラウザを読むのを待つ。relay → ブラウザの向きは、ブラウザに書き終えた分を ACK で返すので、
//! ブラウザが遅ければ relay が TCP を読むのを止める（溜まるのは接続ごとに窓の大きさまで）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Duration;

/// 窓が話せる取り決めの版（`@@kisui-relay <版>@@`）。
pub const VERSION: &str = "1";
const MARKER_HEAD: &[u8] = b"@@kisui-relay ";
/// 目印より前に捨ててよい量（motd など）。これを超えたら、目印は来ないものとみなす。
const MAX_PREAMBLE: u64 = 1 << 20;

const HEADER: usize = 9;
const MAX_PAYLOAD: usize = 64 << 10;
/// 1 本の接続の 1 つの向きで、ACK を待たずに送ってよいバイト数。
pub const WINDOW: usize = 256 << 10;
/// ブラウザから 1 回に読んで 1 つの DATA にする最大。
const CHUNK: usize = 32 << 10;

const OPEN: u8 = 1;
const OPENED: u8 = 2;
const DATA: u8 = 3;
const ACK: u8 = 4;
const EOF: u8 = 5;
const CLOSE: u8 = 6;

/// 中継先の host。`*.localhost`・`0.0.0.0` などの URL も、今までの `ssh -L …:localhost:<ポート>` と同じく `localhost` に向ける
/// （`kisui relay` が `::1`、`127.0.0.1` の順に試す）。
const HOST: &str = "localhost";

/// `kisui relay` を動かしているもの（本番は ssh の子プロセス）。
pub trait Process: Send {
    /// 止める（何度呼んでもよい）。
    fn stop(&mut self);
    /// 出力が終わったあと、終わった理由（ssh の標準エラー出力の最後・終了コード）。
    fn describe(&mut self) -> String;
}

/// `kisui relay` の標準入出力と、それを動かしているもの。
pub struct Transport {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    pub process: Box<dyn Process>,
}

/// relay からブラウザへ書く糸に渡すもの。
enum Event {
    Opened,
    Data(Vec<u8>),
    Eof,
    Close(String),
}

/// ブラウザ → relay の向きの、ACK されていないバイト数。
#[derive(Default)]
struct SendWin {
    unacked: usize,
    closed: bool,
}

struct Stream {
    tx: mpsc::Sender<Event>,
    win: Mutex<SendWin>,
    cv: Condvar,
}

impl Stream {
    /// もう送らない（窓を待っている糸を起こす）。
    fn close_send(&self) {
        self.win.lock().unwrap().closed = true;
        self.cv.notify_all();
    }

    fn closed(&self) -> bool {
        self.win.lock().unwrap().closed
    }
}

/// 標準入力の書き手と、次の接続の番号。番号を決めて OPEN を書くのを 1 つの錠の中で行い、番号の順に OPEN が届くようにする
/// （`kisui relay` は増えていない番号の OPEN を、取り決めの違反として中継ごと止める）。
struct Out {
    w: Box<dyn Write + Send>,
    next: u32,
}

/// 張ってある `kisui relay` 1 本。
pub struct Relay {
    out: Mutex<Out>,
    streams: Mutex<HashMap<u32, Arc<Stream>>>,
    dead: AtomicBool,
    process: Mutex<Box<dyn Process>>,
}

/// [`Relay::probe`] でつながらなかった理由。
#[derive(Debug, PartialEq)]
pub enum ProbeError {
    /// `kisui relay` が CLOSE で断った（理由。`unreachable: …` など）
    Refused(String),
    /// `kisui relay` が答えない（時間切れ・中継が終わった）。ssh が FIN を返さずに切れたときもこれになる
    NoAnswer,
}

/// 目印を読めなかった理由。
enum MarkerError {
    Ended,
    TooLong,
    Version(String),
}

/// 目印（`@@kisui-relay <版>@@`）の行まで読み、それより前を捨てる。
fn read_marker<R: BufRead>(r: &mut R) -> Result<(), MarkerError> {
    let mut seen = 0u64;
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = r
            .take(MAX_PREAMBLE - seen + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| MarkerError::Ended)?;
        if n == 0 {
            return Err(MarkerError::Ended);
        }
        seen += n as u64;
        if let Some(p) = line
            .windows(MARKER_HEAD.len())
            .position(|w| w == MARKER_HEAD)
        {
            let rest = &line[p + MARKER_HEAD.len()..];
            let rest = rest.strip_suffix(b"\n").unwrap_or(rest);
            let rest = rest.strip_suffix(b"\r").unwrap_or(rest);
            let v = rest.strip_suffix(b"@@").unwrap_or(rest);
            if v == VERSION.as_bytes() {
                return Ok(());
            }
            return Err(MarkerError::Version(
                String::from_utf8_lossy(v).into_owned(),
            ));
        }
        if seen > MAX_PREAMBLE {
            return Err(MarkerError::TooLong);
        }
    }
}

fn frame(typ: u8, id: u32, payload: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(HEADER + payload.len());
    b.push(typ);
    b.extend_from_slice(&id.to_be_bytes());
    b.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    b.extend_from_slice(payload);
    b
}

impl Relay {
    /// `t` の目印を待ち（`timeout` まで。ssh の質問に答える時間を含む）、中継を始める。目印が来なければ止めて、理由を返す。
    pub fn start(t: Transport, timeout: Duration) -> Result<Arc<Relay>, String> {
        let Transport {
            reader,
            writer,
            mut process,
        } = t;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut r = BufReader::with_capacity(MAX_PAYLOAD + HEADER, reader);
            let res = read_marker(&mut r);
            let _ = tx.send((res, r));
        });
        let r = match rx.recv_timeout(timeout) {
            Ok((Ok(()), r)) => r,
            Ok((Err(e), _)) => {
                process.stop();
                let why = process.describe();
                return Err(match e {
                    MarkerError::Version(v) => format!(
                        "kisui relay on the machine speaks version {v:?}; this kisui-terminal needs {VERSION:?}"
                    ),
                    MarkerError::TooLong => "kisui relay did not start (no start marker)".into(),
                    MarkerError::Ended if why.is_empty() => "kisui relay did not start".into(),
                    MarkerError::Ended => why,
                });
            }
            Err(_) => {
                process.stop();
                return Err("timed out while starting kisui relay over ssh".into());
            }
        };
        let relay = Arc::new(Relay {
            out: Mutex::new(Out { w: writer, next: 1 }),
            streams: Mutex::default(),
            dead: AtomicBool::new(false),
            process: Mutex::new(process),
        });
        let me = Arc::clone(&relay);
        std::thread::spawn(move || me.dispatch(r));
        Ok(relay)
    }

    /// 中継が使えるか（ssh が切れていないか）。
    pub fn alive(&self) -> bool {
        !self.dead.load(Ordering::SeqCst)
    }

    /// 止める（ssh を殺す）。中継している接続は、読む糸が標準出力の終わりを見て閉じる。
    pub fn close(&self) {
        self.dead.store(true, Ordering::SeqCst);
        self.process.lock().unwrap().stop();
    }

    /// `kisui relay` の標準出力を読み、枠を接続に振り分ける。終わったら（ssh が切れた・壊れた枠）、全部の接続を閉じる。
    fn dispatch<R: Read>(&self, mut r: R) {
        loop {
            let mut h = [0u8; HEADER];
            if r.read_exact(&mut h).is_err() {
                break;
            }
            let typ = h[0];
            let id = u32::from_be_bytes([h[1], h[2], h[3], h[4]]);
            let n = u32::from_be_bytes([h[5], h[6], h[7], h[8]]) as usize;
            if n > MAX_PAYLOAD {
                break;
            }
            let mut p = vec![0u8; n];
            if r.read_exact(&mut p).is_err() {
                break;
            }
            match typ {
                OPENED => self.deliver(id, Event::Opened),
                DATA if !p.is_empty() => self.deliver(id, Event::Data(p)),
                DATA => {}
                EOF => self.deliver(id, Event::Eof),
                CLOSE => {
                    let s = self.streams.lock().unwrap().remove(&id);
                    if let Some(s) = s {
                        s.close_send();
                        let _ =
                            s.tx.send(Event::Close(String::from_utf8_lossy(&p).into_owned()));
                    }
                }
                ACK => {
                    let Ok(b) = <[u8; 4]>::try_from(p.as_slice()) else {
                        break;
                    };
                    if let Some(s) = self.get(id) {
                        let mut w = s.win.lock().unwrap();
                        w.unacked = w.unacked.saturating_sub(u32::from_be_bytes(b) as usize);
                        drop(w);
                        s.cv.notify_all();
                    }
                }
                _ => break,
            }
        }
        self.dead.store(true, Ordering::SeqCst);
        let all: Vec<Arc<Stream>> = self
            .streams
            .lock()
            .unwrap()
            .drain()
            .map(|(_, s)| s)
            .collect();
        for s in all {
            s.close_send();
            let _ = s.tx.send(Event::Close("relay ended".into()));
        }
        self.process.lock().unwrap().stop();
    }

    fn get(&self, id: u32) -> Option<Arc<Stream>> {
        self.streams.lock().unwrap().get(&id).cloned()
    }

    /// 知らない番号（閉じたあと）あての枠は捨てる（行き違いはありうる）。
    fn deliver(&self, id: u32, ev: Event) {
        if let Some(s) = self.get(id) {
            let _ = s.tx.send(ev);
        }
    }

    /// 枠を 1 つ書く。書けなければ（ssh が切れた）死んだ印を付ける。
    fn send(&self, typ: u8, id: u32, payload: &[u8]) -> bool {
        if !self.alive() {
            return false;
        }
        let b = frame(typ, id, payload);
        let mut o = self.out.lock().unwrap();
        if o.w.write_all(&b).and_then(|_| o.w.flush()).is_err() {
            self.dead.store(true, Ordering::SeqCst);
            return false;
        }
        true
    }

    /// 新しい接続を作り、OPEN を送る。
    fn open(&self, port: u16) -> Option<(u32, Arc<Stream>, mpsc::Receiver<Event>)> {
        if !self.alive() {
            return None;
        }
        let (tx, rx) = mpsc::channel();
        let s = Arc::new(Stream {
            tx,
            win: Mutex::default(),
            cv: Condvar::new(),
        });
        let mut payload = port.to_be_bytes().to_vec();
        payload.extend_from_slice(HOST.as_bytes());
        let mut o = self.out.lock().unwrap();
        let id = o.next;
        o.next = o.next.wrapping_add(1);
        self.streams.lock().unwrap().insert(id, Arc::clone(&s));
        let b = frame(OPEN, id, &payload);
        if o.w.write_all(&b).and_then(|_| o.w.flush()).is_err() {
            drop(o);
            self.dead.store(true, Ordering::SeqCst);
            self.streams.lock().unwrap().remove(&id);
            return None;
        }
        Some((id, s, rx))
    }

    /// 接続を捨てる（CLOSE を送る）。もう無ければ何もしない。
    fn abort(&self, id: u32, reason: &str) {
        let s = self.streams.lock().unwrap().remove(&id);
        if let Some(s) = s {
            s.close_send();
            let _ = s.tx.send(Event::Close(reason.into()));
            self.send(CLOSE, id, reason.as_bytes());
        }
    }

    /// リモートのマシンの `port` につながるかを確かめる（つないで、すぐ閉じる）。
    /// `ssh -L` では、つなぎ先が断っても手元のポートは受けてしまい、分からなかった。
    pub fn probe(&self, port: u16, timeout: Duration) -> Result<(), ProbeError> {
        let (id, _s, rx) = self.open(port).ok_or(ProbeError::NoAnswer)?;
        match rx.recv_timeout(timeout) {
            Ok(Event::Close(reason)) if self.alive() => Err(ProbeError::Refused(reason)),
            Ok(Event::Close(_)) => Err(ProbeError::NoAnswer),
            Ok(_) => {
                self.abort(id, "");
                Ok(())
            }
            Err(_) => {
                self.abort(id, "");
                Err(ProbeError::NoAnswer)
            }
        }
    }

    /// ブラウザの接続 `sock` を、リモートのマシンの `port` へ中継する。終わるまで返らない（呼んだ糸がブラウザを読む）。
    /// つなげなかったとき（そのポートで誰も待っていない など）は、ブラウザの接続を閉じる（ブラウザは「接続が切れた」を出す）。
    pub fn pipe(self: &Arc<Self>, sock: TcpStream, port: u16) {
        let _ = sock.set_nodelay(true);
        let Ok(wsock) = sock.try_clone() else {
            return;
        };
        let Some((id, s, rx)) = self.open(port) else {
            return;
        };
        let me = Arc::clone(self);
        std::thread::spawn(move || me.to_browser(id, rx, wsock));
        self.from_browser(id, &s, sock);
    }

    /// relay から来たものをブラウザに書き、書けた分を ACK する。
    fn to_browser(&self, id: u32, rx: mpsc::Receiver<Event>, mut sock: TcpStream) {
        for ev in rx {
            match ev {
                Event::Opened => {}
                Event::Data(b) => {
                    if sock.write_all(&b).is_err() {
                        self.abort(id, "error: writing to the browser failed");
                        break;
                    }
                    self.send(ACK, id, &(b.len() as u32).to_be_bytes());
                }
                Event::Eof => {
                    let _ = sock.shutdown(Shutdown::Write);
                }
                Event::Close(_) => break,
            }
        }
        let _ = sock.shutdown(Shutdown::Both);
    }

    /// ブラウザから読んで DATA で送る。ACK されていない分が窓を超えるなら、読むのを待つ。
    fn from_browser(&self, id: u32, s: &Stream, mut sock: TcpStream) {
        let mut buf = vec![0u8; CHUNK];
        loop {
            let n = match sock.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => {
                    if !s.closed() {
                        self.abort(id, "error: reading from the browser failed");
                    }
                    return;
                }
            };
            let mut w = s.win.lock().unwrap();
            while !w.closed && w.unacked + n > WINDOW {
                w = s.cv.wait(w).unwrap();
            }
            if w.closed {
                return;
            }
            w.unacked += n;
            drop(w);
            if !self.send(DATA, id, &buf[..n]) {
                return;
            }
        }
        if !s.closed() {
            self.send(EOF, id, &[]);
        }
    }
}

/// 試験用の偽の `kisui relay`（Rust で書いた最小のもの。127.0.0.1 にだけつなぐ）。
#[cfg(test)]
pub mod fake {
    use super::*;
    use std::io::{PipeReader, PipeWriter};
    use std::net::Ipv4Addr;
    use std::sync::atomic::AtomicUsize;

    type Shared = Arc<Mutex<Option<PipeWriter>>>;

    /// 偽の relay を外から見る・止めるための手。
    #[derive(Clone)]
    pub struct Handle {
        out: Shared,
        /// 受けた OPEN の数
        pub opens: Arc<AtomicUsize>,
        /// 真にすると、何を受けても答えない（ssh が FIN を返さずに切れたのと同じ）
        pub silent: Arc<AtomicBool>,
        /// 受けた DATA のバイト数
        pub received: Arc<AtomicUsize>,
    }

    impl Handle {
        /// ssh が切れたのと同じにする（窓へ書く向きを閉じる）。
        pub fn die(&self) {
            self.out.lock().unwrap().take();
        }
    }

    struct FakeProcess(Handle);

    impl Process for FakeProcess {
        fn stop(&mut self) {
            self.0.die();
        }
        fn describe(&mut self) -> String {
            "fake relay ended".into()
        }
    }

    fn put(out: &Shared, typ: u8, id: u32, p: &[u8]) {
        if let Some(w) = out.lock().unwrap().as_mut() {
            let _ = w.write_all(&frame(typ, id, p));
        }
    }

    /// `preamble` を書いてから目印（`marker`）を書く偽の relay。`ack` が偽なら、DATA を数えるだけで書かず、ACK も返さない。
    pub fn start(preamble: &str, marker: &str, ack: bool) -> (Transport, Handle) {
        let (win_r, fake_w) = std::io::pipe().unwrap();
        let (fake_r, win_w) = std::io::pipe().unwrap();
        let h = Handle {
            out: Arc::new(Mutex::new(Some(fake_w))),
            opens: Arc::default(),
            received: Arc::default(),
            silent: Arc::default(),
        };
        {
            let mut g = h.out.lock().unwrap();
            let w = g.as_mut().unwrap();
            w.write_all(preamble.as_bytes()).unwrap();
            w.write_all(marker.as_bytes()).unwrap();
        }
        let hh = h.clone();
        std::thread::spawn(move || serve(fake_r, hh, ack));
        let t = Transport {
            reader: Box::new(win_r),
            writer: Box::new(win_w),
            process: Box::new(FakeProcess(h.clone())),
        };
        (t, h)
    }

    fn serve(mut r: PipeReader, h: Handle, ack: bool) {
        let mut conns: HashMap<u32, TcpStream> = HashMap::new();
        loop {
            let mut hd = [0u8; HEADER];
            if r.read_exact(&mut hd).is_err() {
                return;
            }
            let id = u32::from_be_bytes([hd[1], hd[2], hd[3], hd[4]]);
            let n = u32::from_be_bytes([hd[5], hd[6], hd[7], hd[8]]) as usize;
            let mut p = vec![0u8; n];
            if r.read_exact(&mut p).is_err() {
                return;
            }
            match hd[0] {
                _ if h.silent.load(Ordering::SeqCst) => {}
                OPEN => {
                    h.opens.fetch_add(1, Ordering::SeqCst);
                    let port = u16::from_be_bytes([p[0], p[1]]);
                    assert_eq!(&p[2..], HOST.as_bytes());
                    match TcpStream::connect((Ipv4Addr::LOCALHOST, port)) {
                        Err(e) => put(&h.out, CLOSE, id, format!("unreachable: {e}").as_bytes()),
                        Ok(c) => {
                            put(&h.out, OPENED, id, &[]);
                            let mut rc = c.try_clone().unwrap();
                            conns.insert(id, c);
                            let out = Arc::clone(&h.out);
                            std::thread::spawn(move || {
                                let mut b = vec![0u8; CHUNK];
                                loop {
                                    match rc.read(&mut b) {
                                        Ok(0) | Err(_) => break,
                                        Ok(n) => put(&out, DATA, id, &b[..n]),
                                    }
                                }
                                put(&out, EOF, id, &[]);
                                put(&out, CLOSE, id, &[]);
                            });
                        }
                    }
                }
                DATA => {
                    h.received.fetch_add(p.len(), Ordering::SeqCst);
                    if ack {
                        if let Some(c) = conns.get_mut(&id) {
                            let _ = c.write_all(&p);
                        }
                        put(&h.out, ACK, id, &(p.len() as u32).to_be_bytes());
                    }
                }
                EOF => {
                    if let Some(c) = conns.get(&id) {
                        let _ = c.shutdown(Shutdown::Write);
                    }
                }
                CLOSE => {
                    if let Some(c) = conns.remove(&id) {
                        let _ = c.shutdown(Shutdown::Both);
                    }
                }
                _ => {}
            }
        }
    }

    /// 受けたものをそのまま返す TCP のサーバー（リモートのマシンの開発サーバーの代わり）。ポートを返す。
    pub fn echo_server() -> u16 {
        let l = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for c in l.incoming() {
                let Ok(mut c) = c else { continue };
                std::thread::spawn(move || {
                    let mut r = c.try_clone().unwrap();
                    let _ = std::io::copy(&mut r, &mut c);
                    let _ = c.shutdown(Shutdown::Write);
                });
            }
        });
        port
    }

    /// 誰も待っていないポート。
    pub fn closed_port() -> u16 {
        let l = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        l.local_addr().unwrap().port()
    }
}

#[cfg(test)]
mod tests {
    use super::fake;
    use super::*;
    use std::net::{Ipv4Addr, TcpListener};
    use std::sync::atomic::Ordering;
    use std::time::Instant;

    const MARKER: &str = "@@kisui-relay 1@@\n";
    const T: Duration = Duration::from_secs(10);

    /// ブラウザの接続の代わり：手元で 1 本つなぎ、受けた側を `relay.pipe` に渡す。つないだ側を返す。
    fn browser(relay: &Arc<Relay>, port: u16) -> TcpStream {
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let c = TcpStream::connect(l.local_addr().unwrap()).unwrap();
        let (s, _) = l.accept().unwrap();
        let r = Arc::clone(relay);
        std::thread::spawn(move || r.pipe(s, port));
        c.set_read_timeout(Some(T)).unwrap();
        c
    }

    fn round_trip(relay: &Arc<Relay>, port: u16, data: &[u8]) -> Vec<u8> {
        let mut c = browser(relay, port);
        let mut w = c.try_clone().unwrap();
        let d = data.to_vec();
        let wt = std::thread::spawn(move || {
            w.write_all(&d).unwrap();
            w.shutdown(Shutdown::Write).unwrap();
        });
        let mut got = Vec::new();
        c.read_to_end(&mut got).unwrap();
        wt.join().unwrap();
        got
    }

    #[test]
    fn relays_more_than_the_window() {
        let port = fake::echo_server();
        let (t, _h) = fake::start("", MARKER, true);
        let relay = Relay::start(t, T).unwrap();
        let data: Vec<u8> = (0..(3 * WINDOW + 123)).map(|i| (i % 251) as u8).collect();
        assert_eq!(round_trip(&relay, port, &data), data);
    }

    #[test]
    fn many_connections_at_once() {
        let port = fake::echo_server();
        let (t, h) = fake::start("", MARKER, true);
        let relay = Relay::start(t, T).unwrap();
        let ts: Vec<_> = (0..8)
            .map(|i| {
                let r = Arc::clone(&relay);
                std::thread::spawn(move || {
                    let d = vec![i as u8; 100_000 + i];
                    assert_eq!(round_trip(&r, port, &d), d);
                })
            })
            .collect();
        for t in ts {
            t.join().unwrap();
        }
        assert_eq!(h.opens.load(Ordering::SeqCst), 8);
    }

    #[test]
    fn skips_what_the_login_shell_prints_before_the_marker() {
        let port = fake::echo_server();
        let (t, _h) = fake::start("Welcome to the machine\nlast login: today\n", MARKER, true);
        let relay = Relay::start(t, T).unwrap();
        assert_eq!(round_trip(&relay, port, b"hello"), b"hello");
    }

    #[test]
    fn refuses_another_version() {
        let (t, _h) = fake::start("", "@@kisui-relay 2@@\n", true);
        let e = Relay::start(t, T).err().unwrap();
        assert!(e.contains("version \"2\""), "{e}");
    }

    #[test]
    fn says_why_when_relay_does_not_start() {
        let (t, h) = fake::start("motd\n", "", true);
        h.die();
        assert_eq!(Relay::start(t, T).err().unwrap(), "fake relay ended");
    }

    #[test]
    fn probe_tells_when_nothing_listens() {
        let (t, _h) = fake::start("", MARKER, true);
        let relay = Relay::start(t, T).unwrap();
        let Err(ProbeError::Refused(e)) = relay.probe(fake::closed_port(), T) else {
            panic!("must be refused");
        };
        assert!(e.starts_with("unreachable"), "{e}");
        relay.probe(fake::echo_server(), T).unwrap();
        // 確かめた接続は閉じてある
        assert!(relay.streams.lock().unwrap().is_empty());
    }

    /// ssh が FIN を返さずに切れた（何も答えない）relay は、時間切れで NoAnswer になり、死んだ印は付かない（張り直すかは使う側が決める）。
    #[test]
    fn probe_times_out_when_the_relay_does_not_answer() {
        let (t, h) = fake::start("", MARKER, true);
        let relay = Relay::start(t, T).unwrap();
        h.silent.store(true, Ordering::SeqCst);
        assert_eq!(
            relay.probe(fake::echo_server(), Duration::from_millis(200)),
            Err(ProbeError::NoAnswer)
        );
        assert!(relay.alive());
        assert!(relay.streams.lock().unwrap().is_empty());
    }

    #[test]
    fn closes_the_browser_when_nothing_listens() {
        let (t, _h) = fake::start("", MARKER, true);
        let relay = Relay::start(t, T).unwrap();
        let mut c = browser(&relay, fake::closed_port());
        let mut got = Vec::new();
        let _ = c.read_to_end(&mut got);
        assert!(got.is_empty());
    }

    /// relay が ACK を返さなければ、窓（256 KiB）より多くは送らない（ブラウザを読むのを止める）。
    #[test]
    fn stops_reading_the_browser_at_the_window() {
        let port = fake::echo_server();
        let (t, h) = fake::start("", MARKER, false);
        let relay = Relay::start(t, T).unwrap();
        let c = browser(&relay, port);
        let mut w = c.try_clone().unwrap();
        std::thread::spawn(move || {
            let _ = w.write_all(&vec![7u8; 8 * WINDOW]);
        });
        // 受けた量が増えなくなるまで待つ
        let start = Instant::now();
        let mut last = usize::MAX;
        loop {
            std::thread::sleep(Duration::from_millis(300));
            let n = h.received.load(Ordering::SeqCst);
            if n == last && n > 0 {
                break;
            }
            last = n;
            assert!(start.elapsed() < T, "the relay kept receiving");
        }
        assert!(last <= WINDOW, "sent {last} bytes without an ack");
        assert!(last > WINDOW - CHUNK, "stopped too early at {last}");
    }

    /// ssh が切れたら、中継していた接続は閉じ、Relay は死んだ印になる。
    #[test]
    fn closes_connections_when_ssh_ends() {
        let port = fake::echo_server();
        let (t, h) = fake::start("", MARKER, true);
        let relay = Relay::start(t, T).unwrap();
        let mut c = browser(&relay, port);
        c.write_all(b"ping").unwrap();
        let mut b = [0u8; 4];
        c.read_exact(&mut b).unwrap();
        assert_eq!(&b, b"ping");
        h.die();
        let mut rest = Vec::new();
        let _ = c.read_to_end(&mut rest);
        assert!(rest.is_empty());
        let start = Instant::now();
        while relay.alive() {
            assert!(start.elapsed() < T);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(relay.probe(port, T), Err(ProbeError::NoAnswer));
    }
}
