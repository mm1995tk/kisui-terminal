//! 内蔵ブラウザのパスキー（#206）。パスキーが要る場面だけ外のブラウザ（Chrome か Firefox）に移ってログインし、
//! ログインした後の Cookie を内蔵ブラウザに写して戻る。取り決めは `docs/passkey-extension.md`。
//!
//! 流れ:
//! 1. 内蔵ブラウザのページ（設定の `[gui.browser] passkey_sites` に書いたサイト）が `navigator.credentials.get` か `create` で
//!    パスキーを求めると、ページに入れたスクリプト（browser_passkey.js）が `kisui-passkey:` の URL で殻に知らせる
//!    （browser.rs の on_new_window が受ける。nonce が合うものだけ）。
//! 2. 殻は、そのタブの今の URL（一番上のフレーム）の host が設定の項目に当たれば（`site_matches`）、その URL を外のブラウザで開き、
//!    「その項目のログインを待っている」と覚える（`WAIT` の間）。ページには NotAllowedError を返す。
//! 3. 外のブラウザの拡張機能（#207）がログインした後の Cookie を native messaging で送る。ブラウザが起動する受け口
//!    （この実行ファイルを `--native-messaging-host` で起動したもの。`run_host`）が、それを窓の Unix ソケットに渡す。
//! 4. 窓は、待っているサイトの Cookie だけを、内蔵ブラウザの共有のデータに入れ、移る前のタブで同じ URL を開き直す。
//!
//! 受け口から窓への経路（Unix ソケット）は、データのフォルダの `passkey/`（自分だけが入れる 0700 のフォルダ）に置き、
//! つないだ相手のユーザーが自分と同じかも確かめる（ほかのユーザーは Cookie を差し込めず、一覧も読めない）。
//! さらに、窓が外のブラウザに移ったサイトの Cookie だけを、移ってから `WAIT` の間に 1 回だけ受ける。
//! 同じユーザーのほかのプログラムは、受け口を真似れば、その間に限って Cookie を差し込める。ただし同じユーザーのプログラムは、
//! もともと内蔵ブラウザの Cookie の置き場（同じユーザーのファイル）を直接読み書きできるので、この経路で広がる害は無い。

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::webview::cookie::{time::OffsetDateTime, Cookie, SameSite};
use tauri::{AppHandle, Manager, Url};

use crate::config::{GuiConfig, PasskeyBrowser};

/// ページのスクリプトが殻に知らせる URL の scheme。
pub const SCHEME: &str = "kisui-passkey";
/// ページに入れるスクリプト。
const SCRIPT: &str = include_str!("browser_passkey.js");
/// ブラウザが受け口として起動したとき（登録のファイルの指すスクリプトが付ける）の引数。続けてソケットのパス。
pub const HOST_FLAG: &str = "--native-messaging-host";
/// 受け口につないでよい Firefox の拡張機能（#207 の拡張機能の `browser_specific_settings.gecko.id`）。
pub const FIREFOX_EXTENSION_ID: &str = "kisui-terminal@mm1995tk.github.io";
/// 受け口につないでよい Chrome の拡張機能の id（Chrome ウェブストアのアイテム ID。docs/browser-extension.md）。
/// `extension/build.mjs` の `CHROME_PUBLIC_KEY` から計算した id と同じであること（`extension/extension.test.ts` が確かめる）。
/// 空なら Chrome の登録のファイルを置かない。
pub const CHROME_EXTENSION_IDS: &[&str] = &["ljfmfmfcicodilhhbmhkfkgjbcpphjel"];
/// 取り決めの版（`sites` の答えに入れる）。2 で、`sites` に `.google.com` の書き方が入るようになった（#279）。
pub const PROTOCOL_VERSION: u32 = 2;

/// 外のブラウザに移ってから、Cookie を待つ長さ。
const WAIT: Duration = Duration::from_secs(10 * 60);
/// 同じタブから続けて知らせが来ても、外のブラウザを開き直さない間隔。
const MIN_INTERVAL: Duration = Duration::from_secs(3);
/// 拡張機能から受ける 1 つのメッセージの上限（native messaging の拡張機能から受け口への上限 64 MiB より小さく）。
const MAX_REQUEST: usize = 4 << 20;
/// 受け口から拡張機能へ返す 1 つのメッセージの上限（native messaging の上限は 1 MiB）。
const MAX_REPLY: usize = 1 << 20;
/// 1 回に受ける Cookie の数の上限。
const MAX_COOKIES: usize = 1000;
/// Cookie の名前・値の長さの上限。
const MAX_COOKIE_TEXT: usize = 8192;
/// ソケットのフォルダ（データのフォルダの中）。
const DIR: &str = "passkey";
/// ソケットの名前。
const SOCK: &str = "host.sock";
/// 登録のファイルが指すスクリプトの名前（この実行ファイルを `HOST_FLAG` 付きで起動する）。
const SCRIPT_FILE: &str = "native-host";

/// 外のブラウザでのログインを待っているサイト 1 つ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Waiting {
    /// 移る前のタブ（画面が付けた id）
    pub tab: String,
    /// 移る前のタブの URL（Cookie を入れたあとに開き直す）
    pub url: Url,
    at: Instant,
}

/// パスキーのときに外のブラウザへ移る仕組みの状態。設定に `passkey_sites` があるときだけ作る（起動したときの設定を使う）。
pub struct Passkey {
    sites: Vec<String>,
    browser: PasskeyBrowser,
    /// 許可サイトの項目（`passkey_sites` に書いた形）ごとの待ち
    waiting: Mutex<HashMap<String, Waiting>>,
    /// タブごとの、最後に外のブラウザを開いた時刻
    last: Mutex<HashMap<String, Instant>>,
}

/// 拡張機能から受けるメッセージ。
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Request {
    /// 許可サイトの一覧と、待っているサイト
    Sites,
    /// ログインした後の Cookie
    Cookies {
        site: String,
        cookies: Vec<WireCookie>,
    },
}

/// 拡張機能が送る Cookie 1 つ（Chrome と Firefox の `cookies.Cookie` の形。知らない項目は読み飛ばす）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    #[serde(default)]
    pub host_only: bool,
    #[serde(default = "root_path")]
    pub path: String,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub http_only: bool,
    #[serde(default)]
    pub same_site: Option<String>,
    #[serde(default)]
    pub session: bool,
    #[serde(default)]
    pub expiration_date: Option<f64>,
}

fn root_path() -> String {
    "/".into()
}

#[derive(Serialize)]
struct WaitingSite<'a> {
    site: &'a str,
    url: &'a str,
}

/// 断るときの答え。
fn error(code: &str, message: &str) -> Value {
    json!({ "type": "error", "code": code, "message": message })
}

/// host `host` が許可サイトの項目 `site` に当たるか。`github.com` は host が完全に同じときだけ、
/// `.google.com` は `google.com` とそのすべてのサブドメイン（`accounts.google.com`）に当たる。
/// 拡張機能の `extension/lib.js` の `inSite` と、ページに入れる browser_passkey.js も同じ決まり。
pub fn site_matches(host: &str, site: &str) -> bool {
    match site.strip_prefix('.') {
        Some(base) => host == base || host.ends_with(site),
        None => host == site,
    }
}

/// `u` が許可サイトのページなら、当たった項目（`passkey_sites` に書いた形）。http・https だけ。
/// いくつも当たれば、host と完全に同じもの、次に `.` の後ろの長いもの（細かいもの）。
/// 拡張機能の `extension/lib.js` の `siteOf` も同じ決まり。
pub fn site_of(u: &Url, sites: &[String]) -> Option<String> {
    if !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    let host = u.host_str()?;
    sites
        .iter()
        .filter(|s| site_matches(host, s))
        .max_by_key(|s| (!s.starts_with('.'), s.len()))
        .cloned()
}

/// ユーザーがリーダーの操作で外のブラウザでのログインを始めたとき（#276。`o s`）の答え。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Start {
    /// 待ちを覚えた。外のブラウザで開く URL（同じタブから同じサイトに続けて押したときは None。待ちは続いているので開き直さない）
    Opened(Option<Url>),
    /// `passkey_sites` が無い（または内蔵ブラウザを使っていない）
    NoSites,
    /// シークレットのタブ（写した Cookie が外のブラウザに残り、「残さない」と食い違うため使わない）
    Incognito,
    /// タブの今の URL が許可サイトのものでない
    NotAllowed,
}

impl Start {
    /// 画面に返す答えの名前。
    pub fn code(&self) -> &'static str {
        match self {
            Start::Opened(_) => "opened",
            Start::NoSites => "no-sites",
            Start::Incognito => "incognito",
            Start::NotAllowed => "not-allowed",
        }
    }
}

/// パスキーを待たずに、タブ `tab`（今 `url` を出している）のサイトを外のブラウザで開き、そのサイトのログインを待つ（#276）。
/// 許可サイトかの見方（`site_of`）と待ちの単位は、ページがパスキーを求めたとき（`Passkey::hand_off`）と同じ。
pub fn start(p: Option<&Passkey>, incognito: bool, tab: &str, url: &Url, now: Instant) -> Start {
    if incognito {
        return Start::Incognito;
    }
    let Some(p) = p else {
        return Start::NoSites;
    };
    let Some(site) = site_of(url, &p.sites) else {
        return Start::NotAllowed;
    };
    // 続けて開き直さない間隔はタブごと。そのサイトをまだ待っていなければ（3 秒以内に同じタブが別のサイトへ移った）、
    // 間隔を無視して覚える（Opened(None) は「待ちが続いている」ときだけにする）
    if !p.waits_for(&site, now) {
        p.last.lock().unwrap().remove(tab);
    }
    Start::Opened(p.hand_off(tab, url, now))
}

/// ページのスクリプトが知らせた URL か（nonce が合うもの）。
pub fn is_request(u: &Url, nonce: &str) -> bool {
    u.scheme() == SCHEME
        && !nonce.is_empty()
        && u.query_pairs()
            .any(|(k, v)| k == "n" && v.as_ref() == nonce)
}

/// ページに入れるスクリプト（nonce・サイトの一覧・続けて知らせない間隔を埋めたもの）。
pub fn script(nonce: &str, sites: &[String]) -> String {
    let n = serde_json::to_string(nonce).unwrap_or_else(|_| "\"\"".into());
    let s = serde_json::to_string(sites).unwrap_or_else(|_| "[]".into());
    SCRIPT
        .replace("__KISUI_NONCE__", &n)
        .replace("__KISUI_PASSKEY_SITES__", &s)
        .replace(
            "__KISUI_PASSKEY_INTERVAL__",
            &MIN_INTERVAL.as_millis().to_string(),
        )
}

/// 送られた Cookie のうち、許可サイトの項目 `site` に入れてよいものを返す（入れられないものは数えて捨てる）。
/// `site` が `github.com` の書き方なら、`site` のページに送られるものを、`site` だけの Cookie にする。
/// `site` の上のドメインの Cookie（`.cloudflare.com` など）も、`site`（`dash.cloudflare.com`）だけのものにする
/// （上のドメインに入れると、許可していないサイトにも送られるため）。`site` の下のドメインの Cookie は捨てる。
/// `site` が `.google.com` の書き方なら、`google.com` とその下のドメインの Cookie は、そのドメインのまま入れる
/// （どれも許可した範囲。host だけのものは host だけ、サブドメインにも送られるものはサブドメインにも送られるまま）。
/// 上のドメインの Cookie は、`google.com` とそのサブドメインに送られるもの（`.google.com`）にする。
/// 期限の切れたもの・名前や値に使えない文字のあるものも捨てる。同じ名前とパスなら、ドメインのより細かいものが勝つ。
pub fn accept_cookies(
    cookies: &[WireCookie],
    site: &str,
    now: f64,
) -> (Vec<Cookie<'static>>, usize) {
    let mut ok: Vec<(usize, Cookie<'static>)> = Vec::new();
    let mut dropped = 0;
    for c in cookies {
        match accept_cookie(c, site, now) {
            Some(x) => ok.push(x),
            None => dropped += 1,
        }
    }
    // ドメインの細かいものを後に入れる（同じ名前とパスのものを上書きする）
    ok.sort_by_key(|(depth, _)| *depth);
    (ok.into_iter().map(|(_, c)| c).collect(), dropped)
}

/// 名前と値に使える文字か（制御文字と `;` を含まない）。
fn cookie_text(s: &str) -> bool {
    s.len() <= MAX_COOKIE_TEXT && !s.chars().any(|c| c.is_control() || c == ';')
}

/// 1 つの Cookie を確かめる。入れるなら（ドメインの細かさ, `site` だけの Cookie）。
fn accept_cookie(c: &WireCookie, site: &str, now: f64) -> Option<(usize, Cookie<'static>)> {
    let host_only = c.host_only && !c.domain.starts_with('.');
    let domain = c.domain.trim_start_matches('.').to_ascii_lowercase();
    // `.google.com` なら base は `google.com`（その下のドメインもまとめる）
    let (base, subdomains) = match site.strip_prefix('.') {
        Some(b) => (b, true),
        None => (site, false),
    };
    // 許可した範囲の中のドメイン（そのまま入れる）
    let inside = domain == base || (subdomains && domain.ends_with(&format!(".{base}")));
    // base のページに送られる、上のドメインのもの（base のものにする）
    let above = !host_only && domain.contains('.') && base.ends_with(&format!(".{domain}"));
    if !(inside || above)
        || c.name.is_empty()
        || c.name.contains('=')
        || !cookie_text(&c.name)
        || !cookie_text(&c.value)
        || !c.path.starts_with('/')
        || !cookie_text(&c.path)
    {
        return None;
    }
    let to = if inside {
        domain.clone()
    } else {
        base.to_string()
    };
    // WebView（wry の set_cookie）は `Cookie::domain()` の値をそのまま渡し、先頭に `.` の無い domain は host だけの Cookie になる。
    // `github.com` の書き方は、どれも host だけにする（上の説明）。`.google.com` の書き方では、host だけでない Cookie と
    // 上のドメインから寄せたものを、サブドメインにも送られる `.google.com` のままにする（host だけにすると、開き直す
    // `accounts.google.com` に送られない）。`domain()` は先頭の `.` を 1 つ取るので、`..google.com` と入れて `.google.com` を渡す
    let to = if subdomains && !(inside && host_only) {
        format!("..{to}")
    } else {
        to
    };
    let mut b = Cookie::build((c.name.clone(), c.value.clone()))
        .domain(to)
        .path(c.path.clone())
        .secure(c.secure)
        .http_only(c.http_only);
    if let Some(s) = c.same_site.as_deref() {
        b = match s {
            "lax" => b.same_site(SameSite::Lax),
            "strict" => b.same_site(SameSite::Strict),
            "no_restriction" => b.same_site(SameSite::None),
            _ => b,
        };
    }
    if !c.session {
        if let Some(e) = c.expiration_date {
            if !e.is_finite() || e <= now {
                return None;
            }
            let t = OffsetDateTime::from_unix_timestamp(e as i64).ok()?;
            b = b.expires(t);
        }
    }
    // 細かさ：上のドメインのものほど小さい。`site` 自身は host だけのものを一番後に
    let depth = domain.len() * 2 + usize::from(host_only);
    Some((depth, b.build()))
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

impl Passkey {
    /// 許可サイト `sites` と、移る先のブラウザ `browser` で作る（待ちは空）。
    pub fn new(sites: Vec<String>, browser: PasskeyBrowser) -> Self {
        Self {
            sites,
            browser,
            waiting: Mutex::default(),
            last: Mutex::default(),
        }
    }

    /// 設定から作る。内蔵ブラウザを使わない・サイトが無いときは None。
    pub fn from_config(c: &GuiConfig) -> Option<Self> {
        (c.browser && !c.passkey_sites.is_empty())
            .then(|| Self::new(c.passkey_sites.clone(), c.passkey_browser))
    }

    /// 許可サイト（設定の `passkey_sites`）。
    pub fn sites(&self) -> &[String] {
        &self.sites
    }

    /// 移る先のブラウザ（設定の `passkey_browser`）。
    pub fn browser(&self) -> PasskeyBrowser {
        self.browser
    }

    /// タブ `tab`（今 `url` を出している）のページがパスキーを求めた。許可サイトなら待ちを覚え、外のブラウザで開く URL を返す。
    pub fn hand_off(&self, tab: &str, url: &Url, now: Instant) -> Option<Url> {
        let site = site_of(url, &self.sites)?;
        {
            let mut last = self.last.lock().unwrap();
            if let Some(t) = last.get(tab) {
                if now.saturating_duration_since(*t) < MIN_INTERVAL {
                    return None;
                }
            }
            last.insert(tab.to_string(), now);
        }
        self.waiting.lock().unwrap().insert(
            site,
            Waiting {
                tab: tab.to_string(),
                url: url.clone(),
                at: now,
            },
        );
        Some(url.clone())
    }

    /// サイト（`site_of` の答え）のログインを、今も待っているか。
    fn waits_for(&self, site: &str, now: Instant) -> bool {
        let mut w = self.waiting.lock().unwrap();
        Self::expire(&mut w, now);
        w.contains_key(site)
    }

    /// 期限の切れた待ちを捨てる。
    fn expire(w: &mut HashMap<String, Waiting>, now: Instant) {
        w.retain(|_, x| now.saturating_duration_since(x.at) < WAIT);
    }

    /// 拡張機能からのメッセージ 1 つに答える。Cookie を入れるのは `apply`（待っていたタブと、入れる Cookie を受ける）。
    pub fn handle(
        &self,
        msg: &Value,
        now: Instant,
        now_secs: f64,
        apply: impl FnOnce(&Waiting, Vec<Cookie<'static>>) -> Result<(), String>,
    ) -> Value {
        let req = match serde_json::from_value::<Request>(msg.clone()) {
            Ok(r) => r,
            Err(e) => return error("bad-request", &e.to_string()),
        };
        match req {
            Request::Sites => self.answer_sites(now),
            Request::Cookies { site, cookies } => {
                self.take_cookies(&site, &cookies, now, now_secs, apply)
            }
        }
    }

    /// `sites` の答え（許可サイトと、待っているサイト）。
    fn answer_sites(&self, now: Instant) -> Value {
        let mut w = self.waiting.lock().unwrap();
        Self::expire(&mut w, now);
        let mut waiting: Vec<WaitingSite> = w
            .iter()
            .map(|(s, x)| WaitingSite {
                site: s,
                url: x.url.as_str(),
            })
            .collect();
        waiting.sort_by(|a, b| a.site.cmp(b.site));
        json!({
            "type": "sites",
            "version": PROTOCOL_VERSION,
            "sites": self.sites,
            "waiting": waiting,
        })
    }

    /// `cookies` を受ける。待っているサイトの分だけを `apply` に渡し、待ちを終える。
    fn take_cookies(
        &self,
        site: &str,
        cookies: &[WireCookie],
        now: Instant,
        now_secs: f64,
        apply: impl FnOnce(&Waiting, Vec<Cookie<'static>>) -> Result<(), String>,
    ) -> Value {
        if !self.sites.iter().any(|s| s == site) {
            return error("not-allowed", "the site is not in passkey_sites");
        }
        if cookies.len() > MAX_COOKIES {
            return error("bad-request", "too many cookies");
        }
        let (ok, dropped) = accept_cookies(cookies, site, now_secs);
        // 待ちを確かめて取り出すのは 1 回のロックの中で行う（同時に 2 つ届いても、受けるのは 1 つだけ）。
        // 1 回だけ受ける（入れられなくても、待ちは終える）。入れられる Cookie が無ければ、待ちは続ける
        let waiting = {
            let mut w = self.waiting.lock().unwrap();
            Self::expire(&mut w, now);
            let Entry::Occupied(e) = w.entry(site.to_string()) else {
                return error(
                    "not-waiting",
                    "kisui-terminal is not waiting for a login to this site",
                );
            };
            if ok.is_empty() {
                return error("no-cookies", "no cookie of the site was sent");
            }
            e.remove()
        };
        let accepted = ok.len();
        match apply(&waiting, ok) {
            Ok(()) => json!({ "type": "done", "accepted": accepted, "dropped": dropped }),
            Err(e) => error("failed", &e),
        }
    }
}

/// 外のブラウザで `u` を開く。見つからなければ次の候補を試す。
pub fn open_external(browser: PasskeyBrowser, u: &Url) {
    let url = u.to_string();
    std::thread::spawn(move || {
        for (prog, args) in candidates(browser) {
            let child = Command::new(prog)
                .args(args)
                .arg(&url)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            let Ok(mut child) = child else { continue };
            let status = child.wait();
            // macOS の open は、アプリが無いと失敗で終わる。Linux はブラウザそのものなので、起動できれば終わり
            if cfg!(target_os = "macos") && !status.map(|s| s.success()).unwrap_or(false) {
                continue;
            }
            return;
        }
        eprintln!("kisui-terminal: cannot start the browser for passkeys ({browser:?})");
    });
}

/// 外のブラウザを起動するコマンドの候補（前のものから試す）。
fn candidates(browser: PasskeyBrowser) -> Vec<(&'static str, Vec<&'static str>)> {
    if cfg!(target_os = "macos") {
        match browser {
            PasskeyBrowser::Chrome => vec![
                ("open", vec!["-a", "Google Chrome"]),
                ("open", vec!["-a", "Chromium"]),
            ],
            PasskeyBrowser::Firefox => vec![("open", vec!["-a", "Firefox"])],
        }
    } else {
        match browser {
            PasskeyBrowser::Chrome => vec![
                ("google-chrome-stable", vec![]),
                ("google-chrome", vec![]),
                ("chromium", vec![]),
                ("chromium-browser", vec![]),
            ],
            PasskeyBrowser::Firefox => vec![("firefox", vec![])],
        }
    }
}

// ---- 窓の受け口（Unix ソケット） ----

/// つないだ相手のユーザー。
#[cfg(target_os = "linux")]
fn peer_uid(s: &UnixStream) -> std::io::Result<u32> {
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: cred と len は、getsockopt が書く大きさの、生きている領域を指す
    let r = unsafe {
        libc::getsockopt(
            s.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    if r != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(cred.uid)
}

/// つないだ相手のユーザー。
#[cfg(not(target_os = "linux"))]
fn peer_uid(s: &UnixStream) -> std::io::Result<u32> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: uid と gid は、getpeereid が書く、生きている領域を指す
    let r = unsafe { libc::getpeereid(s.as_raw_fd(), &mut uid, &mut gid) };
    if r != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(uid)
}

/// 自分のユーザー。
fn my_uid() -> u32 {
    // SAFETY: getuid は引数を取らず、失敗しない
    unsafe { libc::getuid() }
}

/// 1 行を上限つきで読む（上限を超えたら間違い）。
fn read_line_limited(r: impl Read, max: usize) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    BufReader::new(r.take(max as u64 + 1)).read_until(b'\n', &mut bytes)?;
    if bytes.len() > max {
        return Err(std::io::Error::new(ErrorKind::InvalidData, "too long"));
    }
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    Ok(bytes)
}

/// 自分だけが入れるフォルダを作る（もうあれば 0700 に直す）。
fn private_dir(dir: &Path) -> std::io::Result<()> {
    crate::clipboard_history::create_private_dir(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

/// ソケットのフォルダ。
fn socket_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join(DIR))
}

/// 窓の受け口を作り、受け付けるスレッドを始める。
fn serve(app: &AppHandle, dir: &Path, passkey: Arc<Passkey>) -> std::io::Result<PathBuf> {
    private_dir(dir)?;
    let sock = dir.join(SOCK);
    // 前に動いていたもの（落ちたもの）の残り
    let _ = fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock)?;
    fs::set_permissions(&sock, fs::Permissions::from_mode(0o600))?;
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            let p = Arc::clone(&passkey);
            std::thread::spawn(move || serve_one(&app, &p, stream));
        }
    });
    Ok(sock)
}

/// 受け口からの 1 回（1 行の JSON を受けて 1 行の JSON を返す）。
fn serve_one(app: &AppHandle, p: &Passkey, stream: UnixStream) {
    // ほかのユーザーからは受けない
    if peer_uid(&stream).ok() != Some(my_uid()) {
        return;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let Ok(r) = stream.try_clone() else { return };
    let reply = match read_line_limited(r, MAX_REQUEST)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    {
        Some(msg) => p.handle(&msg, Instant::now(), now_secs(), |w, cookies| {
            apply_cookies(app, w, cookies)
        }),
        None => error("bad-request", "not a JSON line"),
    };
    let mut w = stream;
    let _ = writeln!(w, "{reply}");
}

/// Cookie を内蔵ブラウザの共有のデータに入れ、移る前のタブで同じ URL を開き直し、窓を前に出す。
fn apply_cookies(
    app: &AppHandle,
    w: &Waiting,
    cookies: Vec<Cookie<'static>>,
) -> Result<(), String> {
    let tab = app.get_webview(&crate::browser::label(&w.tab));
    // データはすべてのタブで共有なので、移る前のタブが閉じていれば、ほかのタブから入れる
    let any = tab.clone().or_else(|| {
        app.webviews()
            .into_iter()
            .find(|(l, _)| crate::browser::is_tab_label(l))
            .map(|(_, v)| v)
    });
    let Some(v) = any else {
        return Err("no browser tab is open".into());
    };
    for c in cookies {
        v.set_cookie(c).map_err(|e| e.to_string())?;
    }
    if let Some(t) = tab {
        t.navigate(w.url.clone()).map_err(|e| e.to_string())?;
    }
    if let Some(win) = app.get_window("main") {
        let _ = win.set_focus();
    }
    Ok(())
}

// ---- ブラウザが起動する受け口（native messaging のホスト） ----

/// native messaging のメッセージを 1 つ読む（4 バイトの長さ（そのマシンのバイト順）と JSON）。終わりなら None。
fn read_message(r: &mut impl Read) -> std::io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_ne_bytes(len) as usize;
    if n > MAX_REQUEST {
        return Err(std::io::Error::new(ErrorKind::InvalidData, "too long"));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

/// native messaging のメッセージを 1 つ書く。
fn write_message(w: &mut impl Write, v: &Value) -> std::io::Result<()> {
    let mut body = serde_json::to_vec(v).map_err(std::io::Error::other)?;
    if body.len() > MAX_REPLY {
        body = serde_json::to_vec(&error("failed", "the reply is too long"))
            .map_err(std::io::Error::other)?;
    }
    w.write_all(&(body.len() as u32).to_ne_bytes())?;
    w.write_all(&body)?;
    w.flush()
}

/// 窓に 1 つのメッセージを渡し、答えを受ける。
fn forward(sock: &Path, msg: &Value) -> Value {
    let Ok(mut s) = UnixStream::connect(sock) else {
        return error("not-running", "kisui-terminal is not running");
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(60)));
    if writeln!(s, "{msg}").is_err() {
        return error("not-running", "kisui-terminal did not answer");
    }
    match read_line_limited(&s, MAX_REPLY)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    {
        Some(v) => v,
        None => error("not-running", "kisui-terminal did not answer"),
    }
}

/// 受け口の本体。標準入力のメッセージを窓に渡し、答えを標準出力に返す。終了コードを返す。
pub fn run_host(sock: &Path) -> i32 {
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    loop {
        let msg = match read_message(&mut stdin) {
            Ok(Some(b)) => b,
            Ok(None) => return 0,
            Err(_) => return 1,
        };
        let reply = match serde_json::from_slice::<Value>(&msg) {
            Ok(v) => forward(sock, &v),
            Err(e) => error("bad-request", &e.to_string()),
        };
        if write_message(&mut stdout, &reply).is_err() {
            return 1;
        }
    }
}

// ---- 登録のファイル ----

/// 登録のファイルを置くブラウザの種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Chromium,
    Firefox,
}

/// 登録のファイルを置くフォルダ。（ブラウザが入っている印のフォルダ, 置くフォルダ, 種類）。
/// 印のフォルダが無ければ（そのブラウザを使っていなければ）置かない。
fn manifest_dirs(home: &Path, config_home: Option<&Path>) -> Vec<(PathBuf, PathBuf, Kind)> {
    if cfg!(target_os = "macos") {
        let a = home.join("Library/Application Support");
        let mut v: Vec<_> = ["Google/Chrome", "Chromium"]
            .iter()
            .map(|b| {
                (
                    a.join(b),
                    a.join(b).join("NativeMessagingHosts"),
                    Kind::Chromium,
                )
            })
            .collect();
        v.push((
            a.join("Firefox"),
            a.join("Mozilla/NativeMessagingHosts"),
            Kind::Firefox,
        ));
        v
    } else {
        let cfg = match config_home {
            Some(d) if d.is_absolute() => d.to_path_buf(),
            _ => home.join(".config"),
        };
        let mut v: Vec<_> = ["google-chrome", "chromium"]
            .iter()
            .map(|b| {
                (
                    cfg.join(b),
                    cfg.join(b).join("NativeMessagingHosts"),
                    Kind::Chromium,
                )
            })
            .collect();
        for m in [home.join(".mozilla"), cfg.join("mozilla")] {
            let to = m.join("native-messaging-hosts");
            v.push((m, to, Kind::Firefox));
        }
        v
    }
}

/// native messaging の受け口の名前。アプリの identifier の、英数字と `.` 以外を `_` にしたもの
/// （普通の版は `dev.mm1995tk.kisui_terminal`、nightly 版は `dev.mm1995tk.kisui_terminal_nightly`）。
/// 版ごとに分けるのは、2 つの版を並べて入れたときに、登録のファイルが互いを上書きしたり消したりしないため
/// （ソケットと受け口のスクリプトは、版ごとに別のデータのフォルダにある）。
pub fn host_name(identifier: &str) -> String {
    identifier
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

/// 登録のファイルの中身。
fn manifest(name: &str, kind: Kind, script: &Path) -> Value {
    let mut m = json!({
        "name": name,
        "description": "kisui-terminal: copies the login of passkey sites to its built-in browser",
        "path": script.to_string_lossy(),
        "type": "stdio",
    });
    match kind {
        Kind::Chromium => {
            let o: Vec<String> = CHROME_EXTENSION_IDS
                .iter()
                .map(|id| format!("chrome-extension://{id}/"))
                .collect();
            m["allowed_origins"] = json!(o);
        }
        Kind::Firefox => m["allowed_extensions"] = json!([FIREFOX_EXTENSION_ID]),
    }
    m
}

/// sh の 1 つの引数として書く。
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 中身を `path` に置き換える（別の名前に書いてから置き換える）。
fn write_file(path: &Path, body: &[u8], mode: u32) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let _ = fs::remove_file(&tmp);
    let mut f = crate::clipboard_history::open_private(&tmp)?;
    f.write_all(body)?;
    f.sync_all()?;
    drop(f);
    fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))?;
    fs::rename(&tmp, path)
}

/// 受け口のスクリプト（`dir/native-host`）と、使っているブラウザの登録のファイル（`<name>.json`）を置く。
/// スクリプトは、今の実行ファイルを `HOST_FLAG` とソケットのパス付きで起動する（起動するたびに書き直すので、実行ファイルが動いても追う）。
fn install(
    name: &str,
    dir: &Path,
    sock: &Path,
    exe: &Path,
    home: &Path,
    config_home: Option<&Path>,
) -> std::io::Result<Vec<PathBuf>> {
    let (Some(exe), Some(sock_s)) = (exe.to_str(), sock.to_str()) else {
        return Err(std::io::Error::new(ErrorKind::InvalidData, "not UTF-8"));
    };
    let script = dir.join(SCRIPT_FILE);
    let body = format!(
        "#!/bin/sh\n# kisui-terminal の native messaging の受け口（passkey.rs が起動のたびに書く）\nexec {} {} {}\n",
        sh_quote(exe),
        HOST_FLAG,
        sh_quote(sock_s)
    );
    write_file(&script, body.as_bytes(), 0o700)?;
    let mut written = Vec::new();
    for (marker, to, kind) in manifest_dirs(home, config_home) {
        if !marker.is_dir() || (kind == Kind::Chromium && CHROME_EXTENSION_IDS.is_empty()) {
            continue;
        }
        fs::create_dir_all(&to)?;
        let path = to.join(format!("{name}.json"));
        let body = serde_json::to_vec_pretty(&manifest(name, kind, &script))
            .map_err(std::io::Error::other)?;
        write_file(&path, &body, 0o644)?;
        written.push(path);
    }
    Ok(written)
}

/// 置いた登録のファイル（`<name>.json`。この版のものだけ）を消す（サイトを書かなくなったとき）。
fn uninstall(name: &str, home: &Path, config_home: Option<&Path>) {
    for (_, to, _) in manifest_dirs(home, config_home) {
        let _ = fs::remove_file(to.join(format!("{name}.json")));
    }
}

/// 起動したときに呼ぶ。設定にサイトがあれば、窓の受け口を作り、登録のファイルを置き、状態を `app` に持たせる。
/// 無ければ、前に置いた登録のファイルを消す。
pub fn setup(app: &AppHandle, cfg: Option<&GuiConfig>) {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let config_home = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    let name = host_name(&app.config().identifier);
    let Some(p) = cfg.and_then(Passkey::from_config) else {
        if let Some(h) = &home {
            uninstall(&name, h, config_home.as_deref());
        }
        return;
    };
    let p = Arc::new(p);
    app.manage(Arc::clone(&p));
    let Some(dir) = socket_dir(app) else {
        eprintln!("kisui-terminal: passkey: no data directory");
        return;
    };
    let sock = match serve(app, &dir, p) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "kisui-terminal: passkey: cannot listen on {}: {e}",
                dir.display()
            );
            return;
        }
    };
    // AppImage は、動いている間だけ見える場所から起動しているので、AppImage そのものを指す
    let exe = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok());
    if let (Some(exe), Some(h)) = (exe, home) {
        if let Err(e) = install(&name, &dir, &sock, &exe, &h, config_home.as_deref()) {
            eprintln!("kisui-terminal: passkey: cannot register the native messaging host: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sites() -> Vec<String> {
        vec!["github.com".into(), "dash.cloudflare.com".into()]
    }

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_the_listed_hosts_are_sites() {
        let s = sites();
        assert_eq!(
            site_of(&url("https://github.com/login"), &s).as_deref(),
            Some("github.com")
        );
        assert_eq!(
            site_of(&url("https://dash.cloudflare.com/login"), &s).as_deref(),
            Some("dash.cloudflare.com")
        );
        for bad in [
            "https://gist.github.com/",
            "https://evilgithub.com/",
            "https://github.com.evil.example/",
            "https://cloudflare.com/",
            "file:///github.com",
            "about:blank",
        ] {
            assert_eq!(site_of(&url(bad), &s), None, "{bad}");
        }
    }

    #[test]
    fn requests_need_the_nonce() {
        assert!(is_request(&url("kisui-passkey://passkey?n=abc"), "abc"));
        assert!(!is_request(&url("kisui-passkey://passkey?n=abd"), "abc"));
        assert!(!is_request(&url("kisui-passkey://passkey"), "abc"));
        assert!(!is_request(&url("kisui-passkey://passkey?n="), ""));
        assert!(!is_request(&url("kisui-key://key?n=abc"), "abc"));
        assert!(!is_request(&url("https://github.com/?n=abc"), "abc"));
    }

    #[test]
    fn script_has_the_nonce_and_sites() {
        let s = script("abc\"</script>", &sites());
        assert!(!s.contains("__KISUI_"));
        assert!(s.contains(r#"const nonce = "abc\"</script>";"#), "{s}");
        assert!(s.contains(r#"const sites = ["github.com","dash.cloudflare.com"];"#));
        assert!(s.contains("const interval = 3000;"), "{s}");
        // 殻の受ける URL の形で知らせる
        assert!(SCRIPT.contains("\"kisui-passkey://passkey?n=\""));
        assert!(!SCRIPT.contains("location.href"));
    }

    #[test]
    fn hand_off_only_for_sites_and_not_too_often() {
        let p = Passkey::new(sites(), PasskeyBrowser::Chrome);
        let t0 = Instant::now();
        let u = url("https://github.com/login?return_to=%2F");
        assert_eq!(p.hand_off("t1", &u, t0), Some(u.clone()));
        // 続けて来たものは開き直さない
        assert_eq!(p.hand_off("t1", &u, t0 + Duration::from_secs(1)), None);
        assert_eq!(p.hand_off("t1", &u, t0 + MIN_INTERVAL), Some(u.clone()));
        assert_eq!(p.hand_off("t2", &url("https://example.com/"), t0), None);
        assert_eq!(p.waiting.lock().unwrap().len(), 1);
    }

    // リーダーの操作で始める（#276）。許可サイトの見方と待ちは hand_off と同じ
    #[test]
    fn start_by_hand_only_for_sites_and_not_in_incognito() {
        let p = Passkey::new(sites(), PasskeyBrowser::Chrome);
        let t0 = Instant::now();
        let u = url("https://github.com/login");
        assert_eq!(start(None, false, "t1", &u, t0), Start::NoSites);
        assert_eq!(start(Some(&p), true, "t1", &u, t0), Start::Incognito);
        for other in ["https://example.com/", "https://gist.github.com/"] {
            assert_eq!(
                start(Some(&p), false, "t1", &url(other), t0),
                Start::NotAllowed
            );
        }
        assert!(p.waiting.lock().unwrap().is_empty());
        assert_eq!(
            start(Some(&p), false, "t1", &u, t0),
            Start::Opened(Some(u.clone()))
        );
        // 続けて押しても開き直さない（待ちは続く）
        assert_eq!(
            start(Some(&p), false, "t1", &u, t0 + Duration::from_secs(1)),
            Start::Opened(None)
        );
        let r = p.handle(
            &json!({"type": "sites"}),
            t0,
            0.0,
            |_: &Waiting, _: Vec<Cookie<'static>>| -> Result<(), String> { panic!() },
        );
        assert_eq!(
            r["waiting"],
            json!([{"site": "github.com", "url": "https://github.com/login"}])
        );
        // 同じタブが 3 秒以内に別の許可サイトへ移って押したときは、間隔を待たずにそのサイトを待つ
        let d = url("https://dash.cloudflare.com/login");
        assert_eq!(
            start(Some(&p), false, "t1", &d, t0 + Duration::from_secs(2)),
            Start::Opened(Some(d.clone()))
        );
        assert_eq!(p.waiting.lock().unwrap().len(), 2);
        assert_eq!(Start::Opened(None).code(), "opened");
        assert_eq!(Start::NotAllowed.code(), "not-allowed");
    }

    fn wire(name: &str, domain: &str, host_only: bool) -> WireCookie {
        WireCookie {
            name: name.into(),
            value: "v".into(),
            domain: domain.into(),
            host_only,
            path: "/".into(),
            secure: true,
            http_only: true,
            same_site: Some("lax".into()),
            session: true,
            expiration_date: None,
        }
    }

    #[test]
    fn accepts_only_cookies_sent_to_the_site() {
        let cs = vec![
            wire("user_session", "github.com", true),
            wire("logged_in", ".github.com", false),
            wire("gist", "gist.github.com", true),
            wire("other", "example.com", true),
            wire("tld", ".com", false),
            wire("bad;name", "github.com", true),
            wire("", "github.com", true),
        ];
        let (ok, dropped) = accept_cookies(&cs, "github.com", 0.0);
        let names: Vec<_> = ok.iter().map(|c| c.name().to_string()).collect();
        assert_eq!(names, vec!["logged_in", "user_session"]);
        assert_eq!(dropped, 5);
        for c in &ok {
            // 許可したサイトだけの Cookie にする
            assert_eq!(c.domain(), Some("github.com"));
            assert_eq!(c.http_only(), Some(true));
            assert_eq!(c.secure(), Some(true));
            assert_eq!(c.same_site(), Some(SameSite::Lax));
        }
        // 上のドメインの Cookie は、許可したサイトだけのものにして入れる
        let (ok, _) = accept_cookies(
            &[wire("CF_Authorization", ".cloudflare.com", false)],
            "dash.cloudflare.com",
            0.0,
        );
        assert_eq!(ok[0].domain(), Some("dash.cloudflare.com"));
        // host だけの上のドメインの Cookie は、サイトに送られないので捨てる
        let (ok, dropped) = accept_cookies(
            &[wire("x", "cloudflare.com", true)],
            "dash.cloudflare.com",
            0.0,
        );
        assert!(ok.is_empty());
        assert_eq!(dropped, 1);
    }

    #[test]
    fn expiry_is_kept_and_expired_cookies_are_dropped() {
        let mut c = wire("a", "github.com", true);
        c.session = false;
        c.expiration_date = Some(2_000_000_000.5);
        let (ok, _) = accept_cookies(std::slice::from_ref(&c), "github.com", 1_000.0);
        assert_eq!(
            ok[0].expires_datetime().map(|t| t.unix_timestamp()),
            Some(2_000_000_000)
        );
        let (ok, dropped) = accept_cookies(&[c], "github.com", 2_000_000_001.0);
        assert!(ok.is_empty());
        assert_eq!(dropped, 1);
    }

    #[test]
    fn the_more_specific_cookie_comes_last() {
        let (ok, _) = accept_cookies(
            &[
                wire("s", "github.com", true),
                wire("s", ".github.com", false),
            ],
            "github.com",
            0.0,
        );
        assert_eq!(ok.len(), 2);
        // 後に入れたものが勝つ。host だけのものを後に
        let (ok2, _) = accept_cookies(
            &[
                wire("s", ".github.com", false),
                wire("s", "github.com", true),
            ],
            "github.com",
            0.0,
        );
        assert_eq!(ok.len(), ok2.len());
        let mut a = wire("s", ".github.com", false);
        a.value = "parent".into();
        let mut b = wire("s", "github.com", true);
        b.value = "host".into();
        let (ok, _) = accept_cookies(&[b, a], "github.com", 0.0);
        assert_eq!(ok.last().unwrap().value(), "host");
    }

    fn cookies_msg(site: &str) -> Value {
        json!({
            "type": "cookies",
            "site": site,
            "cookies": [
                { "name": "user_session", "value": "s", "domain": "github.com", "hostOnly": true,
                  "path": "/", "secure": true, "httpOnly": true, "sameSite": "lax", "session": true,
                  "storeId": "0" },
                { "name": "x", "value": "y", "domain": "example.com", "hostOnly": true }
            ]
        })
    }

    #[test]
    fn answers_the_sites_and_what_it_waits_for() {
        let p = Passkey::new(sites(), PasskeyBrowser::Chrome);
        let t0 = Instant::now();
        let never = |_: &Waiting, _: Vec<Cookie<'static>>| -> Result<(), String> { panic!() };
        let r = p.handle(&json!({"type": "sites"}), t0, 0.0, never);
        assert_eq!(
            r,
            json!({"type": "sites", "version": 2, "sites": ["github.com", "dash.cloudflare.com"], "waiting": []})
        );
        p.hand_off("t1", &url("https://github.com/login"), t0);
        let r = p.handle(&json!({"type": "sites"}), t0, 0.0, never);
        assert_eq!(
            r["waiting"],
            json!([{"site": "github.com", "url": "https://github.com/login"}])
        );
        // 待つのは WAIT の間だけ
        let r = p.handle(&json!({"type": "sites"}), t0 + WAIT, 0.0, never);
        assert_eq!(r["waiting"], json!([]));
        let r = p.handle(&json!({"type": "nope"}), t0, 0.0, never);
        assert_eq!(r["code"], "bad-request");
    }

    #[test]
    fn takes_cookies_once_and_only_while_waiting() {
        let p = Passkey::new(sites(), PasskeyBrowser::Chrome);
        let t0 = Instant::now();
        let never = |_: &Waiting, _: Vec<Cookie<'static>>| -> Result<(), String> { panic!() };
        // 許可していないサイト
        let r = p.handle(&cookies_msg("example.com"), t0, 0.0, never);
        assert_eq!(r["code"], "not-allowed");
        // 外のブラウザに移っていないサイト
        let r = p.handle(&cookies_msg("github.com"), t0, 0.0, never);
        assert_eq!(r["code"], "not-waiting");
        p.hand_off("t1", &url("https://github.com/login"), t0);
        let mut got = None;
        let r = p.handle(&cookies_msg("github.com"), t0, 0.0, |w, c| {
            got = Some((w.tab.clone(), w.url.to_string(), c.len()));
            Ok(())
        });
        assert_eq!(r, json!({"type": "done", "accepted": 1, "dropped": 1}));
        assert_eq!(
            got,
            Some(("t1".into(), "https://github.com/login".into(), 1))
        );
        // 2 回目は受けない
        let r = p.handle(&cookies_msg("github.com"), t0, 0.0, never);
        assert_eq!(r["code"], "not-waiting");
        // 期限が切れたら受けない
        p.hand_off("t1", &url("https://github.com/"), t0 + MIN_INTERVAL);
        let r = p.handle(
            &cookies_msg("github.com"),
            t0 + MIN_INTERVAL + WAIT,
            0.0,
            never,
        );
        assert_eq!(r["code"], "not-waiting");
    }

    // 同時に届いても、受けるのは 1 つだけ
    #[test]
    fn takes_cookies_once_even_when_sent_at_the_same_time() {
        let p = Arc::new(Passkey::new(sites(), PasskeyBrowser::Chrome));
        let t0 = Instant::now();
        p.hand_off("t1", &url("https://github.com/login"), t0);
        let applied = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (p, applied) = (Arc::clone(&p), Arc::clone(&applied));
                std::thread::spawn(move || {
                    p.handle(&cookies_msg("github.com"), t0, 0.0, |_, _| {
                        applied.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(20));
                        Ok(())
                    })
                })
            })
            .collect();
        let answers: Vec<Value> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(applied.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(answers.iter().filter(|a| a["type"] == "done").count(), 1);
        assert_eq!(
            answers
                .iter()
                .filter(|a| a["code"] == "not-waiting")
                .count(),
            7
        );
    }

    #[test]
    fn messages_round_trip_in_the_native_messaging_frame() {
        let v = json!({"type": "sites"});
        let mut buf = Vec::new();
        write_message(&mut buf, &v).unwrap();
        assert_eq!(&buf[..4], &(buf.len() as u32 - 4).to_ne_bytes());
        let mut r = &buf[..];
        let got = read_message(&mut r).unwrap().unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&got).unwrap(), v);
        assert!(read_message(&mut r).unwrap().is_none());
        // 長すぎるものは読まない
        let big = ((MAX_REQUEST + 1) as u32).to_ne_bytes();
        assert!(read_message(&mut &big[..]).is_err());
    }

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kisui-passkey-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    // 受け口は、ソケットの向こうの窓にメッセージを渡し、答えを返す。窓が無ければ not-running
    #[test]
    fn the_host_forwards_to_the_socket() {
        let d = temp_dir("forward");
        private_dir(&d).unwrap();
        let sock = d.join(SOCK);
        assert_eq!(
            forward(&sock, &json!({"type": "sites"}))["code"],
            "not-running"
        );
        let l = UnixListener::bind(&sock).unwrap();
        let th = std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            assert_eq!(peer_uid(&s).unwrap(), my_uid());
            let line = read_line_limited(&s, MAX_REQUEST).unwrap();
            let v: Value = serde_json::from_slice(&line).unwrap();
            let mut w = s;
            writeln!(w, "{}", json!({"type": "echo", "got": v})).unwrap();
        });
        let r = forward(&sock, &json!({"type": "sites"}));
        assert_eq!(r, json!({"type": "echo", "got": {"type": "sites"}}));
        th.join().unwrap();
        let mode = fs::metadata(&d).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn installs_the_script_and_manifests_for_browsers_in_use() {
        let d = temp_dir("install");
        let home = d.join("home");
        let dir = d.join("data").join(DIR);
        private_dir(&dir).unwrap();
        let sock = dir.join(SOCK);
        let exe = PathBuf::from("/opt/it's/kisui-terminal");
        // 使っているブラウザ（印のフォルダがあるもの）にだけ置く（Chrome と Firefox は使っていて、Chromium は使っていない）
        let (chrome, chromium, firefox) = if cfg!(target_os = "macos") {
            let a = home.join("Library/Application Support");
            fs::create_dir_all(a.join("Google/Chrome")).unwrap();
            fs::create_dir_all(a.join("Firefox")).unwrap();
            (
                a.join("Google/Chrome/NativeMessagingHosts"),
                a.join("Chromium"),
                a.join("Mozilla/NativeMessagingHosts"),
            )
        } else {
            fs::create_dir_all(home.join(".config/google-chrome")).unwrap();
            fs::create_dir_all(home.join(".mozilla")).unwrap();
            (
                home.join(".config/google-chrome/NativeMessagingHosts"),
                home.join(".config/chromium"),
                home.join(".mozilla/native-messaging-hosts"),
            )
        };
        let name = STABLE;
        let written = install(name, &dir, &sock, &exe, &home, None).unwrap();
        let c = chrome.join(format!("{name}.json"));
        let m = firefox.join(format!("{name}.json"));
        assert_eq!(written, vec![c.clone(), m.clone()]);
        // Chrome には CHROME_EXTENSION_IDS の id だけをつないでよいと書く
        let cv: Value = serde_json::from_slice(&fs::read(&c).unwrap()).unwrap();
        let origins: Vec<Value> = CHROME_EXTENSION_IDS
            .iter()
            .map(|id| json!(format!("chrome-extension://{id}/")))
            .collect();
        assert!(!origins.is_empty());
        assert_eq!(cv["allowed_origins"], Value::Array(origins));
        assert_eq!(cv["allowed_extensions"], Value::Null);
        assert!(!chromium.exists());
        let v: Value = serde_json::from_slice(&fs::read(&m).unwrap()).unwrap();
        assert_eq!(v["name"], name);
        assert_eq!(v["type"], "stdio");
        assert_eq!(v["allowed_extensions"], json!([FIREFOX_EXTENSION_ID]));
        let script = dir.join(SCRIPT_FILE);
        assert_eq!(v["path"], script.to_str().unwrap());
        let body = fs::read_to_string(&script).unwrap();
        assert!(body.starts_with("#!/bin/sh\n"));
        assert!(
            body.contains(&format!(
                "exec '/opt/it'\\''s/kisui-terminal' {HOST_FLAG} '{}'",
                sock.display()
            )),
            "{body}"
        );
        let mode = fs::metadata(&script).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        uninstall(name, &home, None);
        assert!(!c.exists());
        assert!(!m.exists());
        let _ = fs::remove_dir_all(&d);
    }

    const STABLE: &str = "dev.mm1995tk.kisui_terminal";
    const NIGHTLY: &str = "dev.mm1995tk.kisui_terminal_nightly";

    // 受け口の名前は版ごとに別（tauri.conf.json と tauri.nightly.conf.json の identifier から）
    #[test]
    fn host_names_differ_by_version() {
        assert_eq!(host_name("dev.mm1995tk.kisui-terminal"), STABLE);
        assert_eq!(host_name("dev.mm1995tk.kisui-terminal-nightly"), NIGHTLY);
        let conf = |f: &str| -> String {
            let p = Path::new(env!("CARGO_MANIFEST_DIR")).join(f);
            let v: Value = serde_json::from_slice(&fs::read(p).unwrap()).unwrap();
            host_name(v["identifier"].as_str().unwrap())
        };
        assert_eq!(conf("tauri.conf.json"), STABLE);
        assert_eq!(conf("tauri.nightly.conf.json"), NIGHTLY);
    }

    // 普通の版と nightly 版を並べて入れても、登録のファイルは互いを上書きせず、消しもしない
    #[test]
    fn two_versions_keep_their_own_manifests() {
        let d = temp_dir("two");
        let home = d.join("home");
        let exe = PathBuf::from("/x/kisui-terminal");
        let firefox = if cfg!(target_os = "macos") {
            fs::create_dir_all(home.join("Library/Application Support/Firefox")).unwrap();
            home.join("Library/Application Support/Mozilla/NativeMessagingHosts")
        } else {
            fs::create_dir_all(home.join(".mozilla")).unwrap();
            home.join(".mozilla/native-messaging-hosts")
        };
        let mut scripts = Vec::new();
        for (name, data) in [(STABLE, "stable"), (NIGHTLY, "nightly")] {
            let dir = d.join(data).join(DIR);
            private_dir(&dir).unwrap();
            install(name, &dir, &dir.join(SOCK), &exe, &home, None).unwrap();
            scripts.push(dir.join(SCRIPT_FILE));
        }
        let path_of = |name: &str| -> Value {
            let v: Value =
                serde_json::from_slice(&fs::read(firefox.join(format!("{name}.json"))).unwrap())
                    .unwrap();
            v["path"].clone()
        };
        assert_eq!(path_of(STABLE), scripts[0].to_str().unwrap());
        assert_eq!(path_of(NIGHTLY), scripts[1].to_str().unwrap());
        // サイトを書かずに起動した版は、自分の登録だけを消す
        uninstall(STABLE, &home, None);
        assert!(!firefox.join(format!("{STABLE}.json")).exists());
        assert_eq!(path_of(NIGHTLY), scripts[1].to_str().unwrap());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn host_name_is_valid_for_browsers() {
        // Chrome：小文字の英数字・`_`・`.` だけ
        assert!([STABLE, NIGHTLY]
            .concat()
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.'));
    }

    // .google.com の書き方（#279）。そのドメインとすべてのサブドメインに当たる
    #[test]
    fn a_dot_site_matches_the_domain_and_its_subdomains() {
        let s: Vec<String> = vec![".google.com".into(), "github.com".into()];
        for (u, want) in [
            ("https://google.com/", Some(".google.com")),
            ("https://accounts.google.com/v3/signin", Some(".google.com")),
            ("https://myaccount.google.com/", Some(".google.com")),
            ("https://a.b.google.com/", Some(".google.com")),
            ("https://github.com/", Some("github.com")),
            ("https://evilgoogle.com/", None),
            ("https://google.com.evil.example/", None),
            ("https://gist.github.com/", None),
        ] {
            assert_eq!(site_of(&url(u), &s).as_deref(), want, "{u}");
        }
        // いくつも当たれば、host と完全に同じもの、次に細かいもの
        let s: Vec<String> = vec![
            ".google.com".into(),
            ".mail.google.com".into(),
            "accounts.google.com".into(),
        ];
        assert_eq!(
            site_of(&url("https://accounts.google.com/"), &s).as_deref(),
            Some("accounts.google.com")
        );
        assert_eq!(
            site_of(&url("https://x.mail.google.com/"), &s).as_deref(),
            Some(".mail.google.com")
        );
        assert_eq!(
            site_of(&url("https://myaccount.google.com/"), &s).as_deref(),
            Some(".google.com")
        );
    }

    #[test]
    fn a_dot_site_takes_cookies_of_its_domain_as_they_are() {
        let cs = vec![
            wire("SID", ".google.com", false),
            wire("ACCOUNT", "myaccount.google.com", true),
            wire("host", "google.com", true),
            wire("parent", ".com", false),
            wire("other", "example.com", true),
            wire("evil", "evilgoogle.com", true),
        ];
        let (ok, dropped) = accept_cookies(&cs, ".google.com", 0.0);
        let got: Vec<_> = ok
            .iter()
            .map(|c| (c.name().to_string(), c.domain().unwrap().to_string()))
            .collect();
        // WebView には domain() をそのまま渡す。先頭の `.` があればサブドメインにも送られ、無ければ host だけ
        assert_eq!(
            got,
            vec![
                ("SID".to_string(), ".google.com".to_string()),
                ("host".to_string(), "google.com".to_string()),
                ("ACCOUNT".to_string(), "myaccount.google.com".to_string()),
            ]
        );
        assert_eq!(dropped, 3);
        // 上のドメインの Cookie は、許可したドメインとそのサブドメインに送られるものにする
        let (ok, _) = accept_cookies(
            &[wire("CF_Authorization", ".cloudflare.com", false)],
            ".dash.cloudflare.com",
            0.0,
        );
        assert_eq!(ok[0].domain(), Some(".dash.cloudflare.com"));
    }

    // 待つ単位は当たった項目。accounts.google.com で移っても、myaccount.google.com のタブの Cookie を受ける
    #[test]
    fn a_dot_site_waits_for_the_item() {
        let p = Passkey::new(vec![".google.com".into()], PasskeyBrowser::Chrome);
        let t0 = Instant::now();
        let never = |_: &Waiting, _: Vec<Cookie<'static>>| -> Result<(), String> { panic!() };
        let u = url("https://accounts.google.com/v3/signin");
        assert_eq!(p.hand_off("t1", &u, t0), Some(u.clone()));
        let r = p.handle(&json!({"type": "sites"}), t0, 0.0, never);
        assert_eq!(r["sites"], json!([".google.com"]));
        assert_eq!(
            r["waiting"],
            json!([{"site": ".google.com", "url": "https://accounts.google.com/v3/signin"}])
        );
        // 項目でなく host を送っても受けない
        let msg = |site: &str| {
            json!({"type": "cookies", "site": site, "cookies": [
                { "name": "SID", "value": "s", "domain": ".google.com", "hostOnly": false },
                { "name": "A", "value": "a", "domain": "myaccount.google.com", "hostOnly": true }
            ]})
        };
        let r = p.handle(&msg("myaccount.google.com"), t0, 0.0, never);
        assert_eq!(r["code"], "not-allowed");
        let mut got = None;
        let r = p.handle(&msg(".google.com"), t0, 0.0, |w, c| {
            got = Some((w.url.to_string(), c.len()));
            Ok(())
        });
        assert_eq!(r, json!({"type": "done", "accepted": 2, "dropped": 0}));
        assert_eq!(
            got,
            Some(("https://accounts.google.com/v3/signin".into(), 2))
        );
    }
}
