//! 内蔵ブラウザのタブで、ページの読み込みが（ページが出る前に）失敗したことを、画面に知らせる（#432）。
//!
//! 設計書 docs/design/browser-and-proxy.md の「読み込みの失敗」。
//!
//! 証明書が信頼できない・名前が引けない・つながらないなどで、読み込みが始まる前に失敗すると、WebView はページを替えない
//! （前のページが残る）。wry（tauri が使う WebView の層）はこの失敗を殻に知らせないので、OS の WebView から直接受ける：
//! Linux は WebKitGTK の `load-failed`（と、理由が詳しい `load-failed-with-tls-errors`）、macOS は WKNavigationDelegate の
//! `webView:didFailProvisionalNavigation:withError:`（wry の delegate のクラスに足す。browser_capture.rs と同じ手）。
//! 受けたら、タブごとに `browser-load-failed` を画面に送る。画面は、そのタブのページを隠して、開こうとした URL と理由を出す
//! （BrowserArea.tsx）。次に読み込みが始まったら（`browser-page` の `loading`）、画面は失敗の表示を片付ける。
//!
//! - **証明書の確認は緩めない**：ここは失敗を「知らせる」だけで、証明書のエラーを無視して開く道は作らない。
//!   読み込みを許す・続ける答えは、どの OS でも返さない。
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

/// 画面に出す URL・説明の長さの上限（字）。ページが長い URL を作って画面を埋めないように。
const MAX_URL: usize = 2048;
const MAX_DETAIL: usize = 300;

/// 失敗の理由の分類。画面は、これで言葉を選ぶ（app/src/features/browser/loadError.ts と同じ名前）。
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

/// 読み込みが失敗しているタブ → 開こうとした URL。「読み込み直す」（`browser_nav` の reload）が、前のページでなく、
/// 開けなかった URL をもう一度開くために覚える。次に読み込みが始まったら忘れる。
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

    /// タブの失敗を忘れる（読み込みが始まったとき・タブを閉じるとき）。
    pub fn clear(&self, tab: &str) {
        if let Ok(mut m) = self.0.lock() {
            m.remove(tab);
        }
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

/// 読み込みが始まった。前の失敗は、もう無い。
pub fn started(app: &AppHandle, tab: &str) {
    if let Some(f) = app.try_state::<Failures>() {
        f.clear(tab);
    }
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
            // NSURLErrorServerCertificateUntrusted・HasUnknownRoot
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
        // WebKitErrorFrameLoadInterruptedByPolicyChange（102。ダウンロードへの切り替え・遷移の拒否）・
        // WebKitErrorPlugInWillHandleLoad（204）は失敗ではない
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
    use webkit2gtk::glib::Error;
    use webkit2gtk::{NetworkError, PolicyError, WebView, WebViewExt};

    use super::{report, tls_reason, Reason};

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
                // 遷移がダウンロードに替わった（download.rs が受ける）
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
    pub fn watch(app: &AppHandle, w: &WebView, tab: &str) {
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
}

#[cfg(target_os = "macos")]
pub use mac::{register, unregister};

#[cfg(target_os = "macos")]
pub use mac::install;

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Imp, Sel};
    use objc2::{class, msg_send, sel};
    use objc2_foundation::NSString;
    use objc2_web_kit::WKWebView;
    use tauri::{AppHandle, Manager};

    use super::{reason_from_nserror, report};

    thread_local! {
        /// 内蔵ブラウザのタブの WKWebView（アドレス）→ 画面へ知らせる先（AppHandle とタブの id）。メインスレッドだけが触る。
        /// 画面（メインの webview）はここに無いので、失敗を知らせない。
        static TABS: RefCell<HashMap<usize, (AppHandle, String)>> = RefCell::new(HashMap::new());
        static INSTALLED: Cell<Option<bool>> = const { Cell::new(None) };
    }

    /// タブの webview を、失敗を知らせる先として覚える（`with_webview` の閉包の中＝メインスレッドで呼ぶ）。
    pub fn register(app: &AppHandle, webview: &WKWebView, tab: &str) {
        let key = std::ptr::from_ref(webview) as usize;
        TABS.with(|t| t.borrow_mut().insert(key, (app.clone(), tab.to_string())));
    }

    /// タブの webview を忘れる（閉じるとき。同じアドレスに別の webview が作られても、取り違えないように）。
    /// どのスレッドから呼んでもよい。
    pub fn unregister(app: &AppHandle, tab: &str) {
        let tab = tab.to_string();
        let _ = app.run_on_main_thread(move || {
            TABS.with(|t| t.borrow_mut().retain(|_, (_, id)| *id != tab));
        });
    }

    unsafe fn is_kind(obj: &AnyObject, cls: &objc2::runtime::AnyClass) -> bool {
        msg_send![obj, isKindOfClass: cls]
    }

    unsafe fn string_of(obj: Option<Retained<AnyObject>>) -> Option<String> {
        let obj = obj.filter(|o| is_kind(o, class!(NSString)))?;
        let s: Retained<NSString> = Retained::cast_unchecked(obj);
        Some(s.to_string())
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
        let key = std::ptr::from_ref(webview) as usize;
        let Some((app, tab)) = TABS.with(|t| t.borrow().get(&key).cloned()) else {
            return;
        };
        let domain = string_of(msg_send![error, domain]).unwrap_or_default();
        let code: isize = msg_send![error, code];
        let Some(reason) = reason_from_nserror(&domain, code as i64) else {
            return;
        };
        let info: Option<Retained<AnyObject>> = msg_send![error, userInfo];
        let url = info
            .as_deref()
            .filter(|i| is_kind(i, class!(NSDictionary)))
            .and_then(|i| {
                let key = NSString::from_str("NSErrorFailingURLStringKey");
                string_of(msg_send![i, objectForKey: &*key])
            })
            .unwrap_or_default();
        let detail = string_of(msg_send![error, localizedDescription]).unwrap_or_default();
        report(
            &app,
            &tab,
            &url,
            reason,
            &format!("{detail} ({domain} {code})"),
        );
    }

    /// 読み込みの失敗の受け口を、wry が webview に付ける WKNavigationDelegate のクラスに足す（1 度だけ）。
    /// 足せた（か、もう足してある）なら true。wry が持つようになっていたら、上書きせず false（このときは失敗を知らせられない）。
    ///
    /// WebKit は、delegate を webview に付けたときに受け口があるかを調べて覚えるので、タブの webview を作る前に足す
    /// （browser_open が、最初のタブの前に呼ぶ）。メインの画面は、先に作ってあるので「無い」と覚えたままで、変わらない。
    /// 足した受け口は、タブの webview（`register` したもの）のときだけ働く。
    fn install_on(main: &WKWebView) -> bool {
        if let Some(done) = INSTALLED.with(|i| i.get()) {
            return done;
        }
        // SAFETY: メインスレッドで呼ぶ。navigationDelegate は、wry が付けた delegate（無ければ None）。
        // 足す関数の型は、受け口の型（v@:@@@＝戻り値なし・self・_cmd・webview・navigation・error）と同じ
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
                    crate::browser_capture::add_method(
                        d.class(),
                        sel!(webView:didFailProvisionalNavigation:withError:),
                        fail,
                        c"v@:@@@",
                    )
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
    fn failures_are_kept_until_cleared() {
        let f = Failures::default();
        assert_eq!(f.get("a"), None);
        f.set("a", "https://x.test/".into());
        assert_eq!(f.get("a").as_deref(), Some("https://x.test/"));
        f.clear("a");
        assert_eq!(f.get("a"), None);
    }

    #[test]
    fn long_text_is_cut() {
        assert_eq!(cut(&"a".repeat(5000), MAX_URL).chars().count(), MAX_URL);
        assert_eq!(cut("日本語", 2), "日本");
    }
}
