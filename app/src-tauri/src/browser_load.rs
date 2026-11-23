//! 内蔵ブラウザのタブで、ページの読み込みが（ページが出る前に）失敗したことを、画面に知らせる（#432）。
//!
//! 設計書 docs/design/browser-and-proxy.md の「読み込みの失敗」。
//!
//! 証明書が信頼できない・名前が引けない・つながらないなどで、読み込みが始まる前に失敗すると、WebView はページを替えない
//! （前のページが残る）。wry（tauri が使う WebView の層）はこの失敗を殻に知らせないので、OS の WebView から直接受ける：
//! Linux は WebKitGTK の `load-failed`（と、理由が詳しい `load-failed-with-tls-errors`）、macOS は WKNavigationDelegate の
//! `webView:didFailProvisionalNavigation:withError:`（wry の delegate のクラスに足す。browser_capture.rs と同じ手）。
//! 受けたら、タブごとに `browser-load-failed` を画面に送る。画面は、そのタブのページを隠して、開こうとした URL と理由を出す
//! （BrowserArea.tsx）。
//!
//! - **失敗の表示を片付ける**のは、次の読み込みを頼んだとき（`browser_go`・`browser_nav` の reload）と、ページが替わったとき
//!   （`browser-page` の `loading`）。どちらも `clear_failure` を通り、いつも `browser-load-cleared` を送る（殻が失敗を
//!   覚えているかでは決めない。タブを作り直すと殻は覚えをなくすが、画面には失敗の表示が残っているため）。
//!   ページが替わった知らせだけに頼らない：macOS の WebView は、失敗の前に最後に開けたページと同じ URL に移っても、
//!   この知らせを出さないことがある（#432 の macOS での確認）。頼んだ読み込みがまた失敗すれば、失敗の表示が出直す。
//! - **証明書の確認は緩めない**：ここは失敗を「知らせる」だけで、証明書のエラーを無視して開く道は作らない。
//!   読み込みを許す・続ける答えは、どの OS でも返さない。
//! - **プロキシに通したタブ**（#409）は、行き先につながらないと、プロキシが理由のヘッダー（`PROXY_FAILURE_HEADER`）を
//!   付けた 502 をふつうの応答として返すので、WebView の読み込みは失敗にならない。ページ（上のフレーム）の応答に
//!   このヘッダーがあれば、ページを出さずに読み込みを打ち切り（Linux は `decide-policy`、macOS は wry の
//!   `webView:decidePolicyForNavigationResponse:decisionHandler:` を包む）、同じく失敗として知らせる。
//!   ヘッダーを信じるのは、プロキシに通したタブだけ（プロキシは、行き先が同じ名前のヘッダーを返しても渡さない。
//!   通していないタブでは、ページが名乗れてしまう）。
//! - macOS は、期限切れの証明書でも `NSURLErrorServerCertificateUntrusted`（-1202）を返す。エラーに付いてくる行き先の
//!   証明書の有効期間を読み、期限切れ・まだ有効でないを見分ける（`reason_by_dates`）。
//! - Linux は、受け口で WebKit 自前のエラーのページ（英語の素っ気ない 1 枚）を出させない（`load-failed` で true を返す）。
//!   macOS と同じく、前のページを残したまま画面が上に出す。ダウンロードへの切り替え・利用者が次の遷移で打ち切ったなど、
//!   エラーでないものは今までどおり（知らせず、既定の扱い）。
//! - 失敗の URL とエラーの説明の文は、画面に出すだけで、ログには書かない（クエリに載るトークンなどが、ディスクに残るログに
//!   出ないように。browser_capture.rs の失敗のログと同じ方針）。

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// 読み込みが失敗した知らせ（画面へ）。
const EVENT_LOAD_FAILED: &str = "browser-load-failed";
/// 失敗が終わった（次の読み込みを頼んだ・ページが替わった）知らせ（画面へ）。画面は失敗の表示を片付ける。
const EVENT_LOAD_CLEARED: &str = "browser-load-cleared";

/// 通信を記録するプロキシ（`kisui serve` の proxy.*。Go の proxy パッケージ。#409）が、行き先につながらなかったときの
/// 502 に付けるヘッダー（proxy/failure.go の FailureHeader・FailureDetailHeader）。値は Reason の名前（kebab-case）。
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
pub const PROXY_FAILURE_HEADER: &str = "X-Kisui-Proxy-Error";
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
pub const PROXY_FAILURE_DETAIL_HEADER: &str = "X-Kisui-Proxy-Error-Detail";

/// 画面に出す URL・説明の長さの上限（字）。ページが長い URL を作って画面を埋めないように。
const MAX_URL: usize = 2048;
const MAX_DETAIL: usize = 300;

/// 失敗の理由の分類。画面は、これで言葉を選ぶ（app/src/features/browser/loadError.ts と同じ名前）。
/// プロキシ（proxy/failure.go の failureReason）も、同じ名前を使う。
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    /// 証明書が信頼できない（自己署名・発行元が分からない）。macOS は名前の不一致もここに来る（OS が見分けて渡さない）
    CertUntrusted,
    CertExpired,
    CertNotYetValid,
    /// 証明書の名前が、開こうとしたホストと合わない
    CertName,
    CertOther,
    HostNotFound,
    Refused,
    TimedOut,
    Offline,
    /// 読み込みの途中で切れた
    Lost,
    Other,
}

impl Reason {
    /// 名前（kebab-case。画面へ送る形と同じ）から。知らない名前なら None。
    pub fn from_name(name: &str) -> Option<Reason> {
        Some(match name {
            "cert-untrusted" => Reason::CertUntrusted,
            "cert-expired" => Reason::CertExpired,
            "cert-not-yet-valid" => Reason::CertNotYetValid,
            "cert-name" => Reason::CertName,
            "cert-other" => Reason::CertOther,
            "host-not-found" => Reason::HostNotFound,
            "refused" => Reason::Refused,
            "timed-out" => Reason::TimedOut,
            "offline" => Reason::Offline,
            "lost" => Reason::Lost,
            "other" => Reason::Other,
            _ => return None,
        })
    }
}

/// ページ（上のフレーム）の応答が、プロキシの「行き先につながらなかった」応答なら、その理由（知らない名前ならそのほか）。
/// `header` は PROXY_FAILURE_HEADER の値。プロキシに通したタブ（`proxied`）でなければ、ヘッダーがあっても None。
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
pub fn proxy_failure(proxied: bool, main_frame: bool, header: Option<&str>) -> Option<Reason> {
    if !proxied || !main_frame {
        return None;
    }
    header.map(|h| Reason::from_name(h.trim()).unwrap_or(Reason::Other))
}

/// 画面へ知らせる中身。
#[derive(Serialize, Clone, Debug)]
struct LoadFailed {
    tab: String,
    /// 開こうとした URL
    url: String,
    reason: Reason,
    /// OS が出した説明（OS の言語。分類で足りないとき・原因を調べるときの手がかり）。空のこともある
    detail: String,
}

/// 失敗が終わった知らせの中身。
#[derive(Serialize, Clone, Debug)]
struct LoadCleared {
    tab: String,
}

/// 読み込みが失敗しているタブ → 開こうとした URL。「読み込み直す」（`browser_nav` の reload）が、前のページでなく、
/// 開けなかった URL をもう一度開くために覚える。次の読み込みを頼んだとき・ページが替わったときに忘れる。
#[derive(Default)]
pub struct Failures(Mutex<HashMap<String, String>>);

impl Failures {
    /// 失敗したままのタブの、開けなかった URL（切らない元の URL）。失敗していなければ None。「読み込み直す」が使う。
    pub fn get(&self, tab: &str) -> Option<String> {
        self.0.lock().ok()?.get(tab).cloned()
    }

    fn set(&self, tab: &str, url: String) {
        if let Ok(mut m) = self.0.lock() {
            m.insert(tab.to_string(), url);
        }
    }

    /// タブの失敗を忘れる（次の読み込み・タブを閉じるとき）。失敗していたなら true。
    pub fn clear(&self, tab: &str) -> bool {
        self.0.lock().is_ok_and(|mut m| m.remove(tab).is_some())
    }
}

fn cut(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// 失敗を画面に知らせ、「読み込み直す」のために覚える。
pub fn report(app: &AppHandle, tab: &str, url: &str, reason: Reason, detail: &str) {
    // 覚えるのは切る前の URL（「読み込み直す」が別の URL を開かないように。殻の中だけにあり、画面にもログにも出ない）
    if let Some(f) = app.try_state::<Failures>() {
        f.set(tab, url.to_string());
    }
    let url = cut(url, MAX_URL);
    let _ = app.emit(
        EVENT_LOAD_FAILED,
        LoadFailed {
            tab: tab.to_string(),
            url,
            reason,
            detail: cut(detail, MAX_DETAIL),
        },
    );
}

/// 前の失敗は、もう無い（次の読み込みを頼んだ・ページが替わった）。殻の覚えを忘れ、画面に片付けさせる。
/// 画面への知らせは、殻が覚えていなくても送る：タブを作り直す（`browser_close` のあと `browser_open`）と殻の覚えは
/// 消えるが、画面は失敗の表示を持ったままなので、作り直したページが替わったときに片付ける必要がある。
/// 画面は、失敗の表示が無ければ何もしない（ページが替わるたびに来ても変わらない）。
pub fn clear_failure(app: &AppHandle, tab: &str) {
    if let Some(f) = app.try_state::<Failures>() {
        f.clear(tab);
    }
    let _ = app.emit(
        EVENT_LOAD_CLEARED,
        LoadCleared {
            tab: tab.to_string(),
        },
    );
}

/// TLS（証明書）の問題の印から、いちばん知らせたい理由を選ぶ。
/// 期限切れ・まだ有効でない・信頼できない・名前が合わない・そのほか、の順（自己署名で名前も合わないときは「信頼できない」）。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn tls_reason(
    expired: bool,
    not_yet_valid: bool,
    unknown_ca: bool,
    bad_identity: bool,
) -> Reason {
    if expired {
        Reason::CertExpired
    } else if not_yet_valid {
        Reason::CertNotYetValid
    } else if unknown_ca {
        Reason::CertUntrusted
    } else if bad_identity {
        Reason::CertName
    } else {
        Reason::CertOther
    }
}

/// 行き先の証明書（DER。並びの順は問わない）の有効期間から、期限切れ・まだ有効でないを見分ける。`now` は UNIX 時刻（秒）。
/// どれかが期限切れなら期限切れ、そうでなくどれかがまだ有効でなければ「まだ有効でない」。どちらでもない・読めないなら None。
/// macOS は、期限切れでも「信頼できない」（-1202）を返すので、エラーに付いてくる証明書で見分ける（tls_reason と同じく、
/// 期限切れを先に知らせる）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn reason_by_dates<'a>(certs: impl IntoIterator<Item = &'a [u8]>, now: i64) -> Option<Reason> {
    let (mut expired, mut early) = (false, false);
    for der in certs {
        if let Some((not_before, not_after)) = cert_validity(der) {
            expired |= now > not_after;
            early |= now < not_before;
        }
    }
    if expired {
        Some(Reason::CertExpired)
    } else if early {
        Some(Reason::CertNotYetValid)
    } else {
        None
    }
}

/// DER の 1 つの要素：（tag、中身、そのあとの残り）。形が合わなければ None。
/// tag は 1 バイト（X.509 の、ここで読むところはどれも 1 バイト）。長さは 4 バイトまで。
fn der_next(b: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, b) = b.split_first()?;
    let (&first, mut b) = b.split_first()?;
    let len = if first < 0x80 {
        usize::from(first)
    } else {
        let n = usize::from(first & 0x7f);
        if n == 0 || n > 4 || b.len() < n {
            return None;
        }
        let len = b[..n]
            .iter()
            .fold(0usize, |v, &x| (v << 8) | usize::from(x));
        b = &b[n..];
        len
    };
    if b.len() < len {
        return None;
    }
    Some((tag, &b[..len], &b[len..]))
}

/// X.509 の証明書（DER）の有効期間（notBefore・notAfter の UNIX 時刻（秒））。読めなければ None。
/// Certificate ::= SEQUENCE { tbsCertificate, ... }、TBSCertificate ::= SEQUENCE { [0] version（無いこともある）,
/// serialNumber INTEGER, signature SEQUENCE, issuer SEQUENCE, validity SEQUENCE { notBefore, notAfter }, ... }（RFC 5280）。
fn cert_validity(der: &[u8]) -> Option<(i64, i64)> {
    const SEQUENCE: u8 = 0x30;
    let (SEQUENCE, cert, _) = der_next(der)? else {
        return None;
    };
    let (SEQUENCE, tbs, _) = der_next(cert)? else {
        return None;
    };
    let mut field = der_next(tbs)?;
    if field.0 == 0xa0 {
        field = der_next(field.2)?;
    }
    // serialNumber
    if field.0 != 0x02 {
        return None;
    }
    // signature・issuer・validity
    let (SEQUENCE, _, rest) = der_next(field.2)? else {
        return None;
    };
    let (SEQUENCE, _, rest) = der_next(rest)? else {
        return None;
    };
    let (SEQUENCE, validity, _) = der_next(rest)? else {
        return None;
    };
    let (tag, before, rest) = der_next(validity)?;
    let not_before = der_time(tag, before)?;
    let (tag, after, _) = der_next(rest)?;
    Some((not_before, der_time(tag, after)?))
}

/// UTCTime（tag 0x17。YYMMDDHHMMSSZ）か GeneralizedTime（0x18。YYYYMMDDHHMMSSZ）を UNIX 時刻（秒）に。
/// 証明書の時刻は、この形（秒まで・Z）に決まっている（RFC 5280 の 4.1.2.5）。
fn der_time(tag: u8, s: &[u8]) -> Option<i64> {
    let digits = s.strip_suffix(b"Z")?;
    if !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let num = |d: &[u8]| d.iter().fold(0i64, |v, &c| v * 10 + i64::from(c - b'0'));
    let (year, rest) = match (tag, digits.len()) {
        (0x17, 12) => {
            let yy = num(&digits[..2]);
            (if yy >= 50 { 1900 + yy } else { 2000 + yy }, &digits[2..])
        }
        (0x18, 14) => (num(&digits[..4]), &digits[4..]),
        _ => return None,
    };
    let [month, day, hour, minute, second] = [0, 2, 4, 6, 8].map(|i| num(&rest[i..i + 2]));
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// グレゴリオ暦の年月日から、1970-01-01 からの日数。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// macOS の NSError（domain と code）から、知らせる理由を決める。知らせない（利用者・ページが打ち切った、ダウンロードに
/// 替わったなど、失敗でないもの）なら None。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn reason_from_nserror(domain: &str, code: i64) -> Option<Reason> {
    match domain {
        "NSURLErrorDomain" => match code {
            // NSURLErrorCancelled：次の遷移・stop() で打ち切った
            -999 => None,
            // NSURLErrorServerCertificateHasBadDate
            -1201 => Some(Reason::CertExpired),
            // NSURLErrorServerCertificateUntrusted・HasUnknownRoot。macOS は期限切れもここに来る（reason_by_dates で見分ける）
            -1202 | -1203 => Some(Reason::CertUntrusted),
            // NSURLErrorServerCertificateNotYetValid
            -1204 => Some(Reason::CertNotYetValid),
            // NSURLErrorSecureConnectionFailed・ClientCertificateRejected・ClientCertificateRequired
            -1200 | -1205 | -1206 => Some(Reason::CertOther),
            // NSURLErrorCannotFindHost・DNSLookupFailed
            -1003 | -1006 => Some(Reason::HostNotFound),
            // NSURLErrorCannotConnectToHost
            -1004 => Some(Reason::Refused),
            // NSURLErrorTimedOut
            -1001 => Some(Reason::TimedOut),
            // NSURLErrorNotConnectedToInternet・InternationalRoamingOff・DataNotAllowed
            -1009 | -1018 | -1020 => Some(Reason::Offline),
            // NSURLErrorNetworkConnectionLost
            -1005 => Some(Reason::Lost),
            _ => Some(Reason::Other),
        },
        // WebKitErrorFrameLoadInterruptedByPolicyChange（102。ダウンロードへの切り替え・遷移の拒否・プロキシの失敗の応答を
        // 打ち切ったとき）・WebKitErrorPlugInWillHandleLoad（204）は失敗ではない
        "WebKitErrorDomain" if code == 102 || code == 204 => None,
        _ => Some(Reason::Other),
    }
}

#[cfg(target_os = "linux")]
pub use linux::watch;

#[cfg(target_os = "linux")]
mod linux {
    use std::cell::Cell;
    use std::rc::Rc;

    use tauri::AppHandle;
    use webkit2gtk::gio::{IOErrorEnum, TlsCertificateFlags};
    use webkit2gtk::glib::{prelude::Cast, Error};
    use webkit2gtk::{
        NetworkError, PolicyDecisionExt, PolicyDecisionType, PolicyError, ResponsePolicyDecision,
        ResponsePolicyDecisionExt, URIResponseExt, WebView, WebViewExt,
    };

    use super::{
        proxy_failure, report, tls_reason, Reason, PROXY_FAILURE_DETAIL_HEADER,
        PROXY_FAILURE_HEADER,
    };

    /// 失敗（GLib のエラー）から、知らせる理由を決める。知らせない（打ち切り・ダウンロードへの切り替え）なら None。
    fn reason_from_error(e: &Error) -> Option<Reason> {
        if let Some(c) = e.kind::<IOErrorEnum>() {
            return match c {
                IOErrorEnum::Cancelled => None,
                IOErrorEnum::ConnectionRefused => Some(Reason::Refused),
                IOErrorEnum::TimedOut => Some(Reason::TimedOut),
                IOErrorEnum::HostNotFound => Some(Reason::HostNotFound),
                IOErrorEnum::NetworkUnreachable | IOErrorEnum::HostUnreachable => {
                    Some(Reason::Offline)
                }
                IOErrorEnum::NotConnected | IOErrorEnum::BrokenPipe => Some(Reason::Lost),
                _ => Some(Reason::Other),
            };
        }
        if let Some(c) = e.kind::<NetworkError>() {
            return match c {
                NetworkError::Cancelled => None,
                _ => Some(Reason::Other),
            };
        }
        if let Some(c) = e.kind::<PolicyError>() {
            return match c {
                // 遷移がダウンロードに替わった（download.rs が受ける）・プロキシの失敗の応答を打ち切った（下の decide-policy）
                PolicyError::FrameLoadInterruptedByPolicyChange => None,
                _ => Some(Reason::Other),
            };
        }
        match format!("{}", e.domain().as_str()).as_str() {
            "g-resolver-error-quark" => Some(Reason::HostNotFound),
            // TLS のエラー。理由の詳しいほうは `load-failed-with-tls-errors` で先に受けている（呼ぶ側）
            "g-tls-error-quark" => Some(Reason::CertOther),
            _ => Some(Reason::Other),
        }
    }

    /// `load-failed` と `load-failed-with-tls-errors` を受け、失敗を画面に知らせる。`with_webview` の閉包の中で呼ぶ。
    /// 証明書のエラーを無視する道は作らない（TLS の受け口は false を返し、WebKit の既定の扱い＝失敗にする）。
    /// `proxied`（プロキシに通したタブ）なら、プロキシの「行き先につながらなかった」応答も、失敗として知らせる。
    pub fn watch(app: &AppHandle, w: &WebView, tab: &str, proxied: bool) {
        // 直前の証明書の理由（`load-failed-with-tls-errors` が先に来て、すぐ後に `load-failed` が同じ読み込みの失敗を伝える）
        let tls: Rc<Cell<Option<Reason>>> = Rc::new(Cell::new(None));
        {
            let tls = Rc::clone(&tls);
            w.connect_load_failed_with_tls_errors(move |_, _, _, flags| {
                tls.set(Some(tls_reason(
                    flags.contains(TlsCertificateFlags::EXPIRED),
                    flags.contains(TlsCertificateFlags::NOT_ACTIVATED),
                    flags.contains(TlsCertificateFlags::UNKNOWN_CA),
                    flags.contains(TlsCertificateFlags::BAD_IDENTITY),
                )));
                false
            });
        }
        if proxied {
            watch_proxy_failures(app, w, tab);
        }
        let (app, tab) = (app.clone(), tab.to_string());
        w.connect_load_failed(move |_, _, uri, e| {
            let by_tls = tls.take();
            let reason = if format!("{}", e.domain().as_str()) == "g-tls-error-quark" {
                by_tls.or_else(|| reason_from_error(e))
            } else {
                reason_from_error(e)
            };
            match reason {
                Some(r) => {
                    report(&app, &tab, uri, r, e.message());
                    // WebKit 自前のエラーのページは出させない（画面が出す）
                    true
                }
                None => false,
            }
        });
    }

    /// プロキシに通したタブで、ページ（上のフレーム）の応答がプロキシの失敗の応答（PROXY_FAILURE_HEADER 付き）なら、
    /// ページを出さずに打ち切り（`load-failed` は FrameLoadInterruptedByPolicyChange で来て、知らせない）、失敗として知らせる。
    /// そのほかの応答は、何もせず次の受け口（WebKit の既定の扱い）に任せる。wry の `decide-policy` の受け口は、遷移
    /// （NavigationAction）のときしか答えないので、応答のときはここまで来る。
    fn watch_proxy_failures(app: &AppHandle, w: &WebView, tab: &str) {
        let (app, tab) = (app.clone(), tab.to_string());
        w.connect_decide_policy(move |_, d, t| {
            if t != PolicyDecisionType::Response {
                return false;
            }
            let Some(r) = d.downcast_ref::<ResponsePolicyDecision>() else {
                return false;
            };
            let Some(resp) = r.response() else {
                return false;
            };
            let headers = resp.http_headers();
            let header = headers.as_ref().and_then(|h| h.one(PROXY_FAILURE_HEADER));
            let Some(reason) =
                proxy_failure(true, r.is_main_frame_main_resource(), header.as_deref())
            else {
                return false;
            };
            let detail = headers
                .as_ref()
                .and_then(|h| h.one(PROXY_FAILURE_DETAIL_HEADER))
                .map(|s| s.to_string())
                .unwrap_or_default();
            let url = resp.uri().map(|u| u.to_string()).unwrap_or_default();
            report(&app, &tab, &url, reason, &detail);
            d.ignore();
            true
        });
    }
}

#[cfg(target_os = "macos")]
pub use mac::{register, unregister};

#[cfg(target_os = "macos")]
pub use mac::install;

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::sync::OnceLock;
    use std::time::{SystemTime, UNIX_EPOCH};

    use block2::Block;
    use core_foundation::base::{CFGetTypeID, TCFType};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{class, msg_send, sel};
    use objc2_foundation::NSString;
    use objc2_web_kit::WKWebView;
    use security_framework::certificate::SecCertificate;
    use security_framework::trust::SecTrust;
    use tauri::{AppHandle, Manager};

    use super::{
        proxy_failure, reason_by_dates, reason_from_nserror, report, Reason,
        PROXY_FAILURE_DETAIL_HEADER, PROXY_FAILURE_HEADER,
    };

    /// 知らせる先：AppHandle・タブの id・プロキシに通したタブか。
    type Target = (AppHandle, String, bool);

    thread_local! {
        /// 内蔵ブラウザのタブの WKWebView（アドレス）→ 画面へ知らせる先。メインスレッドだけが触る。
        /// 画面（メインの webview）はここに無いので、失敗を知らせない。
        static TABS: RefCell<HashMap<usize, Target>> = RefCell::new(HashMap::new());
        static INSTALLED: Cell<Option<bool>> = const { Cell::new(None) };
    }

    /// wry の `webView:decidePolicyForNavigationResponse:decisionHandler:` の元の実装（包む前のもの）。
    static ORIGINAL_RESPONSE: OnceLock<Imp> = OnceLock::new();

    /// WKNavigationResponsePolicy の値。
    const RESPONSE_CANCEL: isize = 0;

    /// 応答の受け口の型（戻り値なし・self・_cmd・webview・navigationResponse・decisionHandler の block）。
    type ResponseFn =
        unsafe extern "C-unwind" fn(&AnyObject, Sel, &WKWebView, &AnyObject, &Block<dyn Fn(isize)>);

    /// タブの webview を、失敗を知らせる先として覚える（`with_webview` の閉包の中＝メインスレッドで呼ぶ）。
    /// `proxied` は、プロキシ（#409）に通したタブか（プロキシの失敗の応答を、失敗として扱う）。
    pub fn register(app: &AppHandle, webview: &WKWebView, tab: &str, proxied: bool) {
        let key = std::ptr::from_ref(webview) as usize;
        TABS.with(|t| {
            t.borrow_mut()
                .insert(key, (app.clone(), tab.to_string(), proxied))
        });
    }

    /// タブの webview を忘れる（閉じるとき。同じアドレスに別の webview が作られても、取り違えないように）。
    /// どのスレッドから呼んでもよい。
    pub fn unregister(app: &AppHandle, tab: &str) {
        let tab = tab.to_string();
        let _ = app.run_on_main_thread(move || {
            TABS.with(|t| t.borrow_mut().retain(|_, (_, id, _)| *id != tab));
        });
    }

    fn target_of(webview: &WKWebView) -> Option<Target> {
        let key = std::ptr::from_ref(webview) as usize;
        TABS.with(|t| t.borrow().get(&key).cloned())
    }

    unsafe fn is_kind(obj: &AnyObject, cls: &AnyClass) -> bool {
        msg_send![obj, isKindOfClass: cls]
    }

    unsafe fn string_of(obj: Option<Retained<AnyObject>>) -> Option<String> {
        let obj = obj.filter(|o| is_kind(o, class!(NSString)))?;
        let s: Retained<NSString> = Retained::cast_unchecked(obj);
        Some(s.to_string())
    }

    /// 辞書 info（NSDictionary でなければ None）の key の値。
    unsafe fn value_of(info: Option<&AnyObject>, key: &str) -> Option<Retained<AnyObject>> {
        let info = info.filter(|i| is_kind(i, class!(NSDictionary)))?;
        let key = NSString::from_str(key);
        msg_send![info, objectForKey: &*key]
    }

    /// obj が CF の型 type_id のオブジェクトか（`userInfo` の値は決まりの型でないこともあり得るので、包む前に確かめる）。
    fn is_cf(obj: &AnyObject, type_id: core_foundation::base::CFTypeID) -> bool {
        // SAFETY: obj は生きている Objective-C のオブジェクト（CF のオブジェクトとも同じに扱える）
        unsafe { CFGetTypeID(std::ptr::from_ref(obj).cast()) == type_id }
    }

    /// エラーに付いてくる、行き先の証明書（DER）。WebKit は、行き先の信頼の結果（`NSURLErrorFailingURLPeerTrustErrorKey`
    /// の SecTrust）か、証明書の並び（`NSErrorPeerCertificateChainKey`）を付ける。どちらも無ければ空。
    unsafe fn peer_certificates(info: Option<&AnyObject>) -> Vec<Vec<u8>> {
        if let Some(chain) =
            value_of(info, "NSErrorPeerCertificateChainKey").filter(|c| is_kind(c, class!(NSArray)))
        {
            let n: usize = msg_send![&*chain, count];
            let mut out = Vec::new();
            for i in 0..n {
                let c: Option<Retained<AnyObject>> = msg_send![&*chain, objectAtIndex: i];
                if let Some(c) = c.filter(|c| is_cf(c, SecCertificate::type_id())) {
                    // SAFETY: 型を確かめた SecCertificateRef。get の決まりで包む（数を足して、手放すときに引く）
                    let cert =
                        SecCertificate::wrap_under_get_rule(Retained::as_ptr(&c).cast_mut().cast());
                    out.push(cert.to_der());
                }
            }
            if !out.is_empty() {
                return out;
            }
        }
        let Some(trust) = value_of(info, "NSURLErrorFailingURLPeerTrustErrorKey")
            .filter(|t| is_cf(t, SecTrust::type_id()))
        else {
            return Vec::new();
        };
        // SAFETY: 型を確かめた SecTrustRef
        let trust = SecTrust::wrap_under_get_rule(Retained::as_ptr(&trust).cast_mut().cast());
        // 並びを丸ごと返す SecTrustCopyCertificateChain は macOS 12 から。古い macOS でも動くよう、1 枚ずつ読む
        #[allow(deprecated)]
        let certs = (0..trust.certificate_count())
            .filter_map(|i| trust.certificate_at_index(i))
            .map(|c| c.to_der())
            .collect();
        certs
    }

    fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
            .unwrap_or(0)
    }

    /// `webView:didFailProvisionalNavigation:withError:`。ページが出る前の読み込みの失敗。
    /// 内蔵ブラウザのタブなら、画面に知らせる。通しているタブなら、原因を調べるためのログ（browser_capture.rs）も書く。
    /// 画面の知らせにはエラーの説明の文（失敗した URL の全体が入る）も載せるが、ログには書かない。
    unsafe extern "C-unwind" fn did_fail_provisional(
        _this: &AnyObject,
        _cmd: Sel,
        webview: &WKWebView,
        _navigation: *mut AnyObject,
        error: &AnyObject,
    ) {
        crate::browser_capture::log_failure(webview, error);
        let Some((app, tab, _)) = target_of(webview) else {
            return;
        };
        let domain = string_of(msg_send![error, domain]).unwrap_or_default();
        let code: isize = msg_send![error, code];
        let Some(mut reason) = reason_from_nserror(&domain, code as i64) else {
            return;
        };
        let info: Option<Retained<AnyObject>> = msg_send![error, userInfo];
        // 期限切れ・まだ有効でないも「信頼できない」で来るので、行き先の証明書の有効期間で見分ける
        if matches!(reason, Reason::CertUntrusted | Reason::CertOther) {
            let certs = peer_certificates(info.as_deref());
            if let Some(r) = reason_by_dates(certs.iter().map(Vec::as_slice), now()) {
                reason = r;
            }
        }
        let url =
            string_of(value_of(info.as_deref(), "NSErrorFailingURLStringKey")).unwrap_or_default();
        let detail = string_of(msg_send![error, localizedDescription]).unwrap_or_default();
        report(
            &app,
            &tab,
            &url,
            reason,
            &format!("{detail} ({domain} {code})"),
        );
    }

    /// プロキシに通したタブで、ページ（上のフレーム）の応答がプロキシの失敗の応答（PROXY_FAILURE_HEADER 付き）なら、
    /// 失敗として知らせて true（呼ぶ側が読み込みを打ち切る）。
    unsafe fn proxy_failed(webview: &WKWebView, response: &AnyObject) -> bool {
        let Some((app, tab, proxied)) = target_of(webview) else {
            return false;
        };
        if !proxied {
            return false;
        }
        let main: bool = msg_send![response, isForMainFrame];
        let resp: Option<Retained<AnyObject>> = msg_send![response, response];
        let Some(resp) = resp.filter(|r| is_kind(r, class!(NSHTTPURLResponse))) else {
            return false;
        };
        let header = |name: &str| -> Option<String> {
            let name = NSString::from_str(name);
            string_of(msg_send![&*resp, valueForHTTPHeaderField: &*name])
        };
        let Some(reason) = proxy_failure(proxied, main, header(PROXY_FAILURE_HEADER).as_deref())
        else {
            return false;
        };
        let url: Option<Retained<AnyObject>> = msg_send![&*resp, URL];
        let url = url
            .filter(|u| is_kind(u, class!(NSURL)))
            .and_then(|u| string_of(msg_send![&*u, absoluteString]))
            .unwrap_or_default();
        report(
            &app,
            &tab,
            &url,
            reason,
            &header(PROXY_FAILURE_DETAIL_HEADER).unwrap_or_default(),
        );
        true
    }

    /// wry の `webView:decidePolicyForNavigationResponse:decisionHandler:` を包む。プロキシの失敗の応答なら、ページを
    /// 出さずに打ち切る（didFailProvisionalNavigation は WebKitErrorDomain 102 で来て、知らせない）。そのほかは、
    /// wry の元の実装にそのまま渡す。
    unsafe extern "C-unwind" fn decide_response(
        this: &AnyObject,
        cmd: Sel,
        webview: &WKWebView,
        response: &AnyObject,
        handler: &Block<dyn Fn(isize)>,
    ) {
        if proxy_failed(webview, response) {
            handler.call((RESPONSE_CANCEL,));
            return;
        }
        match ORIGINAL_RESPONSE.get() {
            Some(&imp) => {
                // SAFETY: 元の実装は、同じ受け口の型（ResponseFn）
                let original = std::mem::transmute::<Imp, ResponseFn>(imp);
                original(this, cmd, webview, response, handler);
            }
            // 包んでいなければ呼ばれない
            None => handler.call((1,)),
        }
    }

    /// cls 自身が（親のクラスからでなく）sel の実装を持つなら、それを wrapper に替えて、元の実装を返す。
    ///
    /// # Safety
    /// wrapper は元の実装と同じ型で、メインスレッドで呼ぶ。
    unsafe fn wrap_method(cls: &AnyClass, sel: Sel, wrapper: Imp) -> Option<Imp> {
        let methods = cls.instance_methods();
        let m = methods.iter().find(|m| m.name() == sel)?;
        Some(m.set_implementation(wrapper))
    }

    /// 読み込みの失敗の受け口を、wry が webview に付ける WKNavigationDelegate のクラスに足し、プロキシの失敗の応答を
    /// 見る受け口を包む（1 度だけ）。失敗の受け口を足せた（か、もう足してある）なら true。wry が失敗の受け口を
    /// 持つようになっていたら、上書きせず false（このときは失敗を知らせられない）。
    ///
    /// WebKit は、delegate を webview に付けたときに受け口があるかを調べて覚えるので、タブの webview を作る前に足す
    /// （browser_open が、最初のタブの前に呼ぶ）。メインの画面は、先に作ってあるので「無い」と覚えたままで、変わらない。
    /// 足した受け口・包んだ受け口は、タブの webview（`register` したもの）のときだけ働く（ほかは元のまま）。
    fn install_on(main: &WKWebView) -> bool {
        if let Some(done) = INSTALLED.with(|i| i.get()) {
            return done;
        }
        // SAFETY: メインスレッドで呼ぶ。navigationDelegate は、wry が付けた delegate（無ければ None）。
        // 足す・包む関数の型は、受け口の型（失敗：v@:@@@＝戻り値なし・self・_cmd・webview・navigation・error、
        // 応答：ResponseFn）と同じ
        let done = unsafe {
            let delegate: Option<Retained<AnyObject>> = msg_send![main, navigationDelegate];
            match delegate {
                None => false,
                Some(d) => {
                    let fail: Imp = std::mem::transmute::<
                        unsafe extern "C-unwind" fn(
                            &AnyObject,
                            Sel,
                            &WKWebView,
                            *mut AnyObject,
                            &AnyObject,
                        ),
                        Imp,
                    >(did_fail_provisional);
                    let done = crate::browser_capture::add_method(
                        d.class(),
                        sel!(webView:didFailProvisionalNavigation:withError:),
                        fail,
                        c"v@:@@@",
                    );
                    let response = std::mem::transmute::<ResponseFn, Imp>(decide_response);
                    match wrap_method(
                        d.class(),
                        sel!(webView:decidePolicyForNavigationResponse:decisionHandler:),
                        response,
                    ) {
                        Some(original) => {
                            let _ = ORIGINAL_RESPONSE.set(original);
                        }
                        None => eprintln!(
                            "kisui-terminal: cannot watch the proxy's failures in the browser tabs (the navigation delegate does not decide responses)"
                        ),
                    }
                    done
                }
            }
        };
        INSTALLED.with(|i| i.set(Some(done)));
        done
    }

    /// メインの webview の delegate のクラスに、読み込みの失敗の受け口を足す。メインスレッドの外から呼んでよい
    /// （メインスレッドで動かして、終わるのを待つ）。足せなければ、失敗を知らせずに今までどおり開く。
    pub async fn install(app: &AppHandle) {
        let Some(main) = app.get_webview("main") else {
            return;
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        let sent = main.with_webview(move |pv| {
            let ok = crate::browser::wk_webview(&pv).is_some_and(|(w, _)| install_on(w));
            let _ = tx.send(ok);
        });
        if sent.is_err() {
            return;
        }
        if rx.await != Ok(true) {
            eprintln!(
                "kisui-terminal: cannot watch failed loads of the browser tabs (the navigation delegate already handles them, or is missing)"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tls_reasons_are_chosen_by_what_the_user_can_act_on() {
        // expired, not yet valid, unknown CA, bad identity
        assert_eq!(tls_reason(true, false, true, true), Reason::CertExpired);
        assert_eq!(
            tls_reason(false, true, false, false),
            Reason::CertNotYetValid
        );
        // a self-signed certificate for another name is "untrusted" first
        assert_eq!(tls_reason(false, false, true, true), Reason::CertUntrusted);
        assert_eq!(tls_reason(false, false, false, true), Reason::CertName);
        assert_eq!(tls_reason(false, false, false, false), Reason::CertOther);
    }

    #[test]
    fn macos_errors_map_to_reasons() {
        let url = |c| reason_from_nserror("NSURLErrorDomain", c);
        assert_eq!(url(-1202), Some(Reason::CertUntrusted));
        assert_eq!(url(-1201), Some(Reason::CertExpired));
        assert_eq!(url(-1204), Some(Reason::CertNotYetValid));
        assert_eq!(url(-1200), Some(Reason::CertOther));
        assert_eq!(url(-1003), Some(Reason::HostNotFound));
        assert_eq!(url(-1004), Some(Reason::Refused));
        assert_eq!(url(-1001), Some(Reason::TimedOut));
        assert_eq!(url(-1009), Some(Reason::Offline));
        assert_eq!(url(-1005), Some(Reason::Lost));
        assert_eq!(url(-1), Some(Reason::Other));
    }

    #[test]
    fn cancelled_and_policy_changes_are_not_failures() {
        assert_eq!(reason_from_nserror("NSURLErrorDomain", -999), None);
        assert_eq!(reason_from_nserror("WebKitErrorDomain", 102), None);
        assert_eq!(
            reason_from_nserror("WebKitErrorDomain", 101),
            Some(Reason::Other)
        );
        assert_eq!(
            reason_from_nserror("SomethingElse", -999),
            Some(Reason::Other)
        );
    }

    #[test]
    fn reasons_go_to_the_window_in_kebab_case() {
        let v = serde_json::to_string(&Reason::CertNotYetValid).unwrap();
        assert_eq!(v, "\"cert-not-yet-valid\"");
    }

    #[test]
    fn reason_names_round_trip() {
        for r in [
            Reason::CertUntrusted,
            Reason::CertExpired,
            Reason::CertNotYetValid,
            Reason::CertName,
            Reason::CertOther,
            Reason::HostNotFound,
            Reason::Refused,
            Reason::TimedOut,
            Reason::Offline,
            Reason::Lost,
            Reason::Other,
        ] {
            let name = serde_json::to_string(&r).unwrap();
            assert_eq!(Reason::from_name(name.trim_matches('"')), Some(r));
        }
        assert_eq!(Reason::from_name("cert_expired"), None);
    }

    #[test]
    fn only_the_proxied_main_frame_trusts_the_proxy_header() {
        assert_eq!(
            proxy_failure(true, true, Some("cert-expired")),
            Some(Reason::CertExpired)
        );
        // 知らない名前（プロキシの方が新しい）は「そのほか」
        assert_eq!(
            proxy_failure(true, true, Some("something-new")),
            Some(Reason::Other)
        );
        assert_eq!(proxy_failure(true, true, None), None);
        // 通していないタブは、ページが名乗れてしまうので信じない。中のフレームの失敗は、ページを替えない
        assert_eq!(proxy_failure(false, true, Some("refused")), None);
        assert_eq!(proxy_failure(true, false, Some("refused")), None);
    }

    #[test]
    fn failures_are_kept_until_cleared() {
        let f = Failures::default();
        assert_eq!(f.get("a"), None);
        assert!(!f.clear("a"));
        f.set("a", "https://x.test/".into());
        assert_eq!(f.get("a").as_deref(), Some("https://x.test/"));
        assert!(f.clear("a"));
        assert_eq!(f.get("a"), None);
        assert!(!f.clear("a"));
    }

    #[test]
    fn long_text_is_cut() {
        assert_eq!(cut(&"a".repeat(5000), MAX_URL).chars().count(), MAX_URL);
        assert_eq!(cut("日本語", 2), "日本");
    }

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// openssl で作った自己署名の証明書（P-256）。notBefore は 2020-01-01T00:00:00Z（UTCTime）、
    /// notAfter は 2051-01-01T00:00:00Z（GeneralizedTime）。
    const CERT: &str = "3082017030820115a0030201020214179f4bab2589401cefebdb31e6537431e571d5d5300a06082a8648ce3d040302300c310a300806035504030c01743020170d3230303130313030303030305a180f32303531303130313030303030305a300c310a300806035504030c01743059301306072a8648ce3d020106082a8648ce3d030107034200045c3842c31d0475e677ffe6b631794c525136455184cc89fb4791d6fb2242d6ef38645aa367c1a9d4b98e4e13cbfa27e87823347bf08162b4def8b28b0e412870a3533051301d0603551d0e04160414e3c081fd416ac082ecc84f79b9eea023fa8a712a301f0603551d23041830168014e3c081fd416ac082ecc84f79b9eea023fa8a712a300f0603551d130101ff040530030101ff300a06082a8648ce3d0403020349003046022100b6a88798372b664c2358238f97c93d42b1d70fd05fa603cbed2eca728c964f4f022100e59f8e130181370e46f6ca2f32a65fbcb9718b9d4cbbfc437f4fcf0c092c8b85";
    const T2020: i64 = 1_577_836_800;
    const T2051: i64 = 2_556_144_000;

    #[test]
    fn reads_the_validity_of_a_certificate() {
        assert_eq!(cert_validity(&hex(CERT)), Some((T2020, T2051)));
    }

    #[test]
    fn dates_tell_expired_and_not_yet_valid_apart() {
        let c = hex(CERT);
        let one = |now| reason_by_dates([c.as_slice()], now);
        assert_eq!(one(T2051 + 1), Some(Reason::CertExpired));
        assert_eq!(one(T2020 - 1), Some(Reason::CertNotYetValid));
        assert_eq!(one(T2020 + 1), None);
        assert_eq!(reason_by_dates(std::iter::empty(), T2051 + 1), None);
    }

    /// 期間だけを入れた、形だけの証明書（version 無し）。
    fn cert_with(before: (u8, &str), after: (u8, &str)) -> Vec<u8> {
        fn tlv(tag: u8, body: &[u8]) -> Vec<u8> {
            let mut v = vec![tag];
            if body.len() < 0x80 {
                v.push(body.len() as u8);
            } else {
                v.extend([0x82, (body.len() >> 8) as u8, body.len() as u8]);
            }
            v.extend_from_slice(body);
            v
        }
        let validity = [
            tlv(before.0, before.1.as_bytes()),
            tlv(after.0, after.1.as_bytes()),
        ]
        .concat();
        let tbs = [
            tlv(0x02, &[1]),
            tlv(0x30, &[]),
            tlv(0x30, &[]),
            tlv(0x30, &validity),
            // 長い中身（長さが 2 バイトの形）
            tlv(0x30, &[0u8; 300]),
        ]
        .concat();
        tlv(0x30, &tlv(0x30, &tbs))
    }

    #[test]
    fn reads_both_time_forms_and_the_century_of_utc_time() {
        let c = cert_with((0x17, "500101000000Z"), (0x17, "491231235959Z"));
        // UTCTime の 50 以上は 19xx、49 以下は 20xx
        assert_eq!(cert_validity(&c), Some((-631_152_000, 2_524_607_999)));
        let c = cert_with((0x18, "19700101000000Z"), (0x18, "20240229120000Z"));
        assert_eq!(cert_validity(&c), Some((0, 1_709_208_000)));
    }

    #[test]
    fn broken_certificates_are_not_read() {
        let c = hex(CERT);
        // 途中で切れている
        assert_eq!(cert_validity(&c[..c.len() / 3]), None);
        assert_eq!(cert_validity(&[]), None);
        assert_eq!(cert_validity(&[0x30, 0x84, 0xff, 0xff, 0xff, 0xff]), None);
        // 時刻の形が違う（Z が無い・字が数字でない・月が 13）
        assert_eq!(
            cert_validity(&cert_with((0x17, "200101000000"), (0x17, "300101000000Z"))),
            None
        );
        assert_eq!(
            cert_validity(&cert_with((0x17, "2001010000+0Z"), (0x17, "300101000000Z"))),
            None
        );
        assert_eq!(
            cert_validity(&cert_with((0x17, "201301000000Z"), (0x17, "300101000000Z"))),
            None
        );
        assert_eq!(
            cert_validity(&cert_with((0x04, "200101000000Z"), (0x17, "300101000000Z"))),
            None
        );
    }
}
