//! 内蔵ブラウザのタブの favicon（#237）。サイドバーのブラウザのタブの行の頭に出す。
//!
//! 取り方：ページの読み込みが終わったとき・題が変わったときに、殻からページの中で browser_favicon.js を動かし、
//! 返した文字（32×32 の PNG の data: URL）を受けて画面に知らせる（`browser-favicon`）。
//! - 動かすのはページの外の世界（isolated world。Linux は WebKitGTK の world、macOS は WKContentWorld）。ページのスクリプトは
//!   この世界を見られず、DOM の関数を差し替えても効かないので、殻が受ける答えに手を出せるのは、ページの `<link rel="icon">`
//!   （ページ自身の favicon）だけ。殻から呼んで答えを受けるので、ページが偽の知らせを送る口も無い（nonce も要らない）。
//! - 画像を読み込むのはページ自身（ページと同じデータの置き場）。殻と画面（メインの webview）はネットワークに出ない。
//!   シークレットのタブは、ディスクに残さないデータで読み込み、答えは画面の中だけに持つ（browser-tabs.json に書かない）。
//! - 答えは、形（PNG の data: URL）と大きさを確かめてから画面に渡す（`valid`）。違えば "" （画面は地球のアイコン）。
//! - ページの読み込みが始まったら、それまでに頼んだ答えは捨てる（前のページの favicon を新しいページに出さない）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Webview};

/// ページの中で動かすスクリプト（async の矢印関数 1 つ）。
const SCRIPT: &str = include_str!("browser_favicon.js");
/// スクリプトを動かす世界の名前（ページの世界とは別）。
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
const WORLD: &str = "kisui-favicon";
/// 画面に知らせるイベント。
const EVENT_FAVICON: &str = "browser-favicon";
/// 受ける data: URL の頭。
const PREFIX: &str = "data:image/png;base64,";
/// 受ける data: URL の長さの上限（32×32 の PNG は、ふつう数 KB）。
const MAX_LEN: usize = 64 * 1024;

#[derive(Serialize, Clone)]
struct FaviconEvent {
    tab: String,
    /// PNG の data: URL。取れなければ ""
    icon: String,
}

/// タブ 1 つの、ページの読み込みの数（始まるたびに 1 増やす）。答えが来たときに数が変わっていれば、前のページの答えなので捨てる。
#[derive(Clone, Default)]
pub struct Page(Arc<AtomicU64>);

impl Page {
    /// ページの読み込みが始まった。
    pub fn started(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }

    fn now(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// 関数の本体（WebKitGTK の call_async_javascript_function と WKWebView の callAsyncJavaScript は、関数の本体を受ける）。
fn body() -> String {
    format!("return ({})();", SCRIPT.trim().trim_end_matches(';'))
}

/// ページの答えが、画面に出してよい形（PNG の data: URL で、base64 の文字だけ、上限より短い）か。違えば ""。
fn valid(s: &str) -> String {
    let ok = s.len() <= MAX_LEN
        && s.strip_prefix(PREFIX).is_some_and(|b| {
            !b.is_empty()
                && b.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'='))
        });
    if ok {
        s.to_string()
    } else {
        String::new()
    }
}

/// 答えを画面に知らせる。頼んだあとにページの読み込みが始まっていれば捨てる。
fn tell(app: &AppHandle, tab: &str, page: &Page, asked: u64, answer: &str) {
    if page.now() != asked {
        return;
    }
    let _ = app.emit(
        EVENT_FAVICON,
        FaviconEvent {
            tab: tab.to_string(),
            icon: valid(answer),
        },
    );
}

/// タブのページの favicon を読みに行く（答えは後で `browser-favicon` で知らせる）。
pub fn request(app: &AppHandle, v: &Webview, tab: &str, page: &Page) {
    let (app, tab, page) = (app.clone(), tab.to_string(), page.clone());
    let asked = page.now();
    let _ = v.with_webview(move |pv| run(pv, app, tab, page, asked));
}

#[cfg(target_os = "linux")]
fn run(pv: tauri::webview::PlatformWebview, app: AppHandle, tab: String, page: Page, asked: u64) {
    use javascriptcore::ValueExt;
    use webkit2gtk::WebViewExt;
    pv.inner().call_async_javascript_function(
        &body(),
        None,
        Some(WORLD),
        None,
        None::<&webkit2gtk::gio::Cancellable>,
        move |r| {
            let s = match r {
                Ok(v) if v.is_string() => v.to_str().to_string(),
                _ => String::new(),
            };
            tell(&app, &tab, &page, asked, &s);
        },
    );
}

#[cfg(target_os = "macos")]
fn run(pv: tauri::webview::PlatformWebview, app: AppHandle, tab: String, page: Page, asked: u64) {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSError, NSString};
    use objc2_web_kit::{WKContentWorld, WKWebView};

    // with_webview の中はメインスレッド
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let ptr = pv.inner() as *const WKWebView;
    if ptr.is_null() {
        return;
    }
    // SAFETY: tauri の PlatformWebview::inner は、生きている WKWebView を指す（この閉包の間）
    let w: &WKWebView = unsafe { &*ptr };
    let world = unsafe { WKContentWorld::worldWithName(&NSString::from_str(WORLD), mtm) };
    let done: RcBlock<dyn Fn(*mut AnyObject, *mut NSError)> =
        RcBlock::new(move |res: *mut AnyObject, err: *mut NSError| {
            let s = if err.is_null() && !res.is_null() {
                // SAFETY: 終わりの受け口に渡る res は、受け口の間は生きている Objective-C のオブジェクト
                let obj: &AnyObject = unsafe { &*res };
                obj.downcast_ref::<NSString>()
                    .map(|s| s.to_string())
                    .unwrap_or_default()
            } else {
                String::new()
            };
            tell(&app, &tab, &page, asked, &s);
        });
    unsafe {
        w.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
            &NSString::from_str(&body()),
            None,
            None,
            &world,
            Some(&*done),
        );
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn run(_: tauri::webview::PlatformWebview, _: AppHandle, _: String, _: Page, _: u64) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_only_small_png_data_urls() {
        let png = format!("{PREFIX}iVBORw0KGgo+/=");
        assert_eq!(valid(&png), png);
        assert_eq!(valid(""), "");
        assert_eq!(valid(PREFIX), "");
        // ほかの形・ほかの文字を混ぜたもの
        assert_eq!(valid("data:image/svg+xml;base64,PHN2Zz4="), "");
        assert_eq!(valid("https://example.com/favicon.ico"), "");
        assert_eq!(valid(&format!("{PREFIX}abc\"<script>")), "");
        assert_eq!(valid(&format!("{PREFIX}abc def")), "");
        // 大きすぎるもの
        let big = format!("{PREFIX}{}", "A".repeat(MAX_LEN));
        assert_eq!(valid(&big), "");
    }

    // 殻が動かすのは、関数の本体として読める形（スクリプトの矢印関数を呼んで返す）
    #[test]
    fn body_calls_the_script() {
        let b = body();
        assert!(b.starts_with("return (") && b.ends_with(")();"), "{b}");
        assert!(b.contains("async () =>"), "{b}");
        assert!(!b.contains("};)"), "{b}");
    }

    #[test]
    fn answers_for_an_old_page_are_dropped() {
        let p = Page::default();
        let asked = p.now();
        assert_eq!(p.now(), asked);
        p.started();
        assert_ne!(p.now(), asked);
    }
}
