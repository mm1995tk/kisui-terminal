//! 内蔵ブラウザのタブで、ページを読み込み中かと、その進み具合を画面に知らせ、読み込みを止める（#449）。
//!
//! 画面は、これで URL バーの下の端に進み具合の線を出し、↻ を「×」（読み込みを止める）に替える。
//!
//! wry（tauri が使う WebView の層）の `on_page_load` は、macOS では最初の応答が来てから（`didCommitNavigation`）しか「始まった」を
//! 知らせない。読み込みに時間がかかる（つながるまで・証明書の確認で待つ）間は、何も知らせない。そこで、OS の WebView が
//! 持っている「読み込み中か」（Linux は WebKitGTK の `is_loading`、macOS は WKWebView の `isLoading`）と
//! 進み具合（`estimated_load_progress`・`estimatedProgress`）を、遷移が始まったときから終わるまで一定の間隔で読む。
//! 遷移が始まった印は、`on_navigation`（リンク・URL バー・戻る・進む・リダイレクト）と、`browser_go`・`browser_nav`。
//!
//! - 殻は「読み込み中か」を覚えない。読んだ値が前と変わったときだけ `browser-loading` を送る（画面がタブに持つ）。
//! - 読み込みが始まらなかった遷移（ダウンロードに替わった・断った・同じページ内の移動）は、`GRACE` の間に読み込み中に
//!   ならなければ、何も知らせずにやめる。
//! - 止めるのは WebView の `stopLoading`（Linux は `stop_loading`）。打ち切りは、失敗として知らせない
//!   （browser_load.rs が `NSURLErrorCancelled`・`IOErrorEnum::Cancelled` を知らせない）。ページは前のまま残る。
//! - 同じ読みで「戻る先・進む先があるか」（Linux は `can_go_back`・`can_go_forward`、macOS は `canGoBack`・`canGoForward`）も読み、
//!   変わったときだけ `browser-history` を送る（#450。URL バーの ←・→ を押せない見た目にする）。ページが読み込み中でなくても、
//!   読み込みの始まり・終わり・題の変化のたびに、一度だけ読んで知らせる（`sync_history`）。
//! - ページの Esc は、ページのスクリプトが「Esc が押された」とだけ殻に知らせる（browser_keys.js）。殻はそれを画面に
//!   そのまま渡し、止めるかどうかは画面が決める（読み込み中のタブだけ止める）。

use std::collections::HashMap;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Webview};

/// 読み込み中か・進み具合が変わった知らせ（画面へ）。
const EVENT_LOADING: &str = "browser-loading";
/// 戻る先・進む先があるかの知らせ（画面へ）。
const EVENT_HISTORY: &str = "browser-history";
/// ページで Esc が押された知らせ（画面へ）。
pub const EVENT_ESCAPE: &str = "browser-escape";

/// 読み込みの状態を読む間隔。
const POLL: Duration = Duration::from_millis(120);
/// 遷移が始まってから、読み込み中にならなければやめるまでの間。
const GRACE: Duration = Duration::from_millis(2500);
/// 1 回の読み取りを待つ上限（メインスレッドが詰まっているとき）。
const SAMPLE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
struct Loading {
    tab: String,
    loading: bool,
    /// 進み具合（0〜100）。読み込み中でなければ 0
    progress: u8,
}

/// 戻る先・進む先があるかの知らせ（`browser-history`）の中身。
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
struct History {
    tab: String,
    back: bool,
    forward: bool,
}

/// ページで Esc が押された知らせ（`browser-escape`）の中身。どのタブで押されたか。
#[derive(Serialize, Clone, Debug)]
pub struct Escape {
    pub tab: String,
}

/// 読み取りの結果。
#[derive(Debug, PartialEq, Eq)]
enum Sample {
    /// タブの webview が無い（作る前・閉じた）
    Missing,
    /// メインスレッドが詰まっていて、時間内に読めなかった（また読む）
    Busy,
    Read {
        loading: bool,
        progress: u8,
        back: bool,
        forward: bool,
    },
}

/// 状態を見ているタブ → 見張りへの「遷移が始まった」の数。同じタブを 2 つ見ない。
/// 見張りが終わりかけているところに次の遷移が重なったときは、数が変わるので、見張りは終わらずに数え直す。
fn running() -> &'static Mutex<HashMap<String, u64>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 進み具合（0.0〜1.0）を百分率に。
fn percent(p: f64) -> u8 {
    if p.is_nan() {
        return 0;
    }
    (p.clamp(0.0, 1.0) * 100.0).round() as u8
}

/// タブの読み込みの状態を見始める（遷移が始まった）。もう見ていれば、見張りに遷移が増えたことを伝える。
/// どのスレッドから呼んでもよい。
pub fn watch(app: &AppHandle, tab: &str) {
    {
        let mut m = lock(running());
        if let Some(n) = m.get_mut(tab) {
            *n += 1;
            return;
        }
        m.insert(tab.to_string(), 0);
    }
    let (app, tab) = (app.clone(), tab.to_string());
    std::thread::spawn(move || poll(&app, &tab));
}

/// 見張りをやめてよいか。見張りが最後に見た遷移の数（`seen_count`）から増えていなければ、やめる（タブを外す）。
/// 増えていれば、やめずに数を更新して false を返す（次の遷移を、はじめから見る）。
fn finish(tab: &str, seen_count: &mut u64) -> bool {
    let mut m = lock(running());
    match m.get(tab) {
        Some(n) if n != seen_count => {
            *seen_count = *n;
            false
        }
        _ => {
            m.remove(tab);
            true
        }
    }
}

fn poll(app: &AppHandle, tab: &str) {
    let mut count = 0u64;
    let mut started = Instant::now();
    let mut seen = false;
    let mut last: Option<(bool, u8)> = None;
    let mut last_history: Option<(bool, bool)> = None;
    loop {
        std::thread::sleep(POLL);
        let over = match sample(app, tab) {
            // 作る前なら待つ。閉じたなら、何も知らせずにやめる
            Sample::Missing => seen || started.elapsed() > GRACE,
            Sample::Busy => false,
            Sample::Read {
                loading,
                progress,
                back,
                forward,
            } => {
                if last_history != Some((back, forward)) {
                    last_history = Some((back, forward));
                    emit_history(app, tab, back, forward);
                }
                let now = (loading, if loading { progress } else { 0 });
                if loading {
                    seen = true;
                }
                if (loading || seen) && last != Some(now) {
                    last = Some(now);
                    let _ = app.emit(
                        EVENT_LOADING,
                        Loading {
                            tab: tab.to_string(),
                            loading: now.0,
                            progress: now.1,
                        },
                    );
                }
                !loading && (seen || started.elapsed() > GRACE)
            }
        };
        if over {
            if finish(tab, &mut count) {
                return;
            }
            // やめる前に次の遷移が来た。はじめから見る
            started = Instant::now();
            seen = false;
        }
    }
}

fn emit_history(app: &AppHandle, tab: &str, back: bool, forward: bool) {
    let _ = app.emit(
        EVENT_HISTORY,
        History {
            tab: tab.to_string(),
            back,
            forward,
        },
    );
}

/// 戻る先・進む先があるかを一度だけ読んで、画面に知らせる（読み込み中でなくても。読み込みの始まり・終わり・題の変化のとき）。
/// 画面は同じ値を無視するので、変わったかは調べない。どのスレッドから呼んでもよい。
pub fn sync_history(app: &AppHandle, tab: &str) {
    let (app, tab) = (app.clone(), tab.to_string());
    std::thread::spawn(move || {
        if let Sample::Read { back, forward, .. } = sample(&app, &tab) {
            emit_history(&app, &tab, back, forward);
        }
    });
}

fn sample(app: &AppHandle, tab: &str) -> Sample {
    let Some(v) = app.get_webview(&crate::browser::label(tab)) else {
        return Sample::Missing;
    };
    let (tx, rx) = mpsc::channel();
    if v.with_webview(move |pv| {
        let _ = tx.send(read(&pv));
    })
    .is_err()
    {
        return Sample::Missing;
    }
    rx.recv_timeout(SAMPLE_TIMEOUT).unwrap_or(Sample::Busy)
}

#[cfg(target_os = "linux")]
fn read(pv: &tauri::webview::PlatformWebview) -> Sample {
    use webkit2gtk::WebViewExt;
    let w = pv.inner();
    Sample::Read {
        loading: w.is_loading(),
        progress: percent(w.estimated_load_progress()),
        back: w.can_go_back(),
        forward: w.can_go_forward(),
    }
}

#[cfg(target_os = "macos")]
fn read(pv: &tauri::webview::PlatformWebview) -> Sample {
    use objc2::msg_send;
    let Some((w, _)) = crate::browser::wk_webview(pv) else {
        return Sample::Missing;
    };
    // SAFETY: WKWebView の isLoading・canGoBack・canGoForward（BOOL）・estimatedProgress（double）。with_webview の中＝メインスレッド
    let (loading, progress, back, forward): (bool, f64, bool, bool) = unsafe {
        (
            msg_send![w, isLoading],
            msg_send![w, estimatedProgress],
            msg_send![w, canGoBack],
            msg_send![w, canGoForward],
        )
    };
    Sample::Read {
        loading,
        progress: percent(progress),
        back,
        forward,
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn read(_: &tauri::webview::PlatformWebview) -> Sample {
    Sample::Missing
}

/// タブの読み込みを止める。ページは前のまま残る。
pub fn stop(v: &Webview) -> Result<(), String> {
    v.with_webview(|pv| stop_native(&pv))
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn stop_native(pv: &tauri::webview::PlatformWebview) {
    use webkit2gtk::WebViewExt;
    pv.inner().stop_loading();
}

#[cfg(target_os = "macos")]
fn stop_native(pv: &tauri::webview::PlatformWebview) {
    use objc2::msg_send;
    if let Some((w, _)) = crate::browser::wk_webview(pv) {
        // SAFETY: WKWebView の stopLoading。with_webview の中＝メインスレッド
        unsafe {
            let _: () = msg_send![w, stopLoading];
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn stop_native(_: &tauri::webview::PlatformWebview) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_is_clamped() {
        assert_eq!(percent(0.0), 0);
        assert_eq!(percent(0.456), 46);
        assert_eq!(percent(1.7), 100);
        assert_eq!(percent(-1.0), 0);
        assert_eq!(percent(f64::NAN), 0);
    }
}
