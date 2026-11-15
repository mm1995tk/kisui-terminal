//! 内蔵ブラウザのタブ（#202）。設計書 docs/design/browser-and-proxy.md の「GUI の内蔵ブラウザ（入れ直し）」。
//!
//! タブ 1 つにつき、メイン窓の上に重ねる子の webview を 1 つ持つ（OS の WebView。macOS は WKWebView、Linux は WebKitGTK）。
//! 外のサイトの多くは `iframe` に出せない（X-Frame-Options・CSP の frame-ancestors）ので、`<iframe>` は使わない。
//! どこに重ねるか・見せるか隠すかは画面（`app/src/browser/BrowserArea.tsx`）が決め、ここはその通りに置く。
//!
//! 外のページに Tauri の API を渡さない:
//! - 子の webview は `WebviewUrl::External` で作る。外の URL からの IPC は、`remote` を持つ capability が無い限り tauri が断る。
//!   capability はメインの webview（`main`）にだけ与える（capabilities/default.json は `webviews: ["main"]`。
//!   `windows: ["main"]` にすると、同じ窓に置く子の webview にも当たるため）。
//! - そのうえで、ここの命令は呼んだ webview が `main` かも確かめる（`from_main`）。
//! - 子の webview の遷移は http・https・about だけ許す。新しい窓（`target=_blank` など）は開かず、同じタブで開く。
//!
//! ページにキーがある間も、リーダーと近道を効かせる。キーは IPC では受けない。ページに入れるスクリプト（browser_keys.js）が、
//! 当たるキーを `kisui-key:` の URL にして window.open で開こうとし、ここの on_new_window が受けて画面に渡す（開かずに断る）。
//! URL には webview を作るたびに決める nonce を入れ、合わないものは捨てる（ページのスクリプトが真似できないように）。
//! 設定にパスキーのサイト（`[gui.browser] passkey_sites`）があれば、パスキーを捕まえるスクリプト（browser_passkey.js）も入れ、
//! 同じ形（`kisui-passkey:` の URL と同じ nonce）で知らせを受けて、外のブラウザに移る（passkey.rs。#206）。
//!
//! ログイン（Cookie などのページのデータ）は、すべてのタブで 1 つを共有し、ディスクに残す。Linux はデータのフォルダの
//! `browser/` に置く。macOS は WKWebView の既定の置き場（`~/Library/WebKit/<アプリの id>/` など。場所は OS が決める）を使う。
//! 開いていたタブ（ワークスペースと URL）は、データのフォルダの `browser-tabs.json` に覚える（画面が書く）。

use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder,
    WebviewUrl,
};

use crate::open_url::{from_main, parse_url};
use crate::passkey::{self, Passkey};

/// 子の webview のラベルの頭（画面が決めたタブの id を後ろに付ける）。
const LABEL_PREFIX: &str = "browser-";
/// キーを殻に知らせる URL の scheme。
const KEY_SCHEME: &str = "kisui-key";
/// ページに入れるスクリプト。
const KEY_SCRIPT: &str = include_str!("browser_keys.js");
/// 開いていたタブを覚えるファイル（データのフォルダの中）。
const TABS_FILE: &str = "browser-tabs.json";
/// ページのデータ（Cookie など）を置くフォルダ（データのフォルダの中。Linux だけ使う）。
#[cfg(not(target_os = "macos"))]
const DATA_DIR: &str = "browser";
/// 覚えるファイルの形式の版。
const FORMAT_VERSION: u32 = 1;
/// 覚えるタブの数の上限。
const MAX_TABS: usize = 500;
/// 送ってよいキーの数の上限（リーダーと近道の数より十分多く）。
const MAX_KEYS: usize = 64;

/// 画面に知らせるイベント。
const EVENT_KEY: &str = "browser-key";
const EVENT_PAGE: &str = "browser-page";
const EVENT_TITLE: &str = "browser-title";

/// ページで受けるキー 1 つ（keyspec.ts の KeySpec と同じ形）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeySpec {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
    pub key: String,
    /// リーダーとグループの入口（押したあとのキーも続けて送る）
    pub enter: bool,
}

/// ページで押されたキー（画面の KeyLike に戻す）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyEvent {
    pub tab: String,
    pub key: String,
    pub code: String,
    pub ctrl_key: bool,
    pub shift_key: bool,
    pub alt_key: bool,
    pub meta_key: bool,
    pub repeat: bool,
}

#[derive(Serialize, Clone)]
struct PageEvent {
    tab: String,
    url: String,
    loading: bool,
}

#[derive(Serialize, Clone)]
struct TitleEvent {
    tab: String,
    title: String,
}

/// 覚えるタブ 1 つ。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredTab {
    pub id: String,
    /// 開いたときのワークスペースのマシン（ssh の行き先か `@local`）
    pub target: String,
    pub workspace: String,
    pub url: String,
    #[serde(default)]
    pub title: String,
}

/// タブの並びを畳んだワークスペース。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredWs {
    pub target: String,
    pub workspace: String,
}

/// 覚えるもの（`browser-tabs.json`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredTabs {
    #[serde(default)]
    pub tabs: Vec<StoredTab>,
    #[serde(default)]
    pub collapsed: Vec<StoredWs>,
}

#[derive(Serialize, Deserialize)]
struct StoredFile {
    version: u32,
    #[serde(flatten)]
    data: StoredTabs,
}

/// 画面が付けるタブの id（子の webview のラベルにする）。
fn valid_tab(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 32
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub(crate) fn label(tab: &str) -> String {
    format!("{LABEL_PREFIX}{tab}")
}

/// タブの子の webview のラベルか。
pub(crate) fn is_tab_label(l: &str) -> bool {
    l.strip_prefix(LABEL_PREFIX).is_some_and(valid_tab)
}

/// 子の webview（タブ）。
fn child(app: &AppHandle, tab: &str) -> Result<Webview, String> {
    if !valid_tab(tab) {
        return Err("invalid tab id".into());
    }
    app.get_webview(&label(tab))
        .ok_or_else(|| "no such browser tab".to_string())
}

/// 推し量れない 16 バイトを 16 進で（キーの URL の nonce）。`/dev/urandom` が読めなければ失敗する
/// （推し量れる値で続けると、ページのスクリプトがキーを真似できてしまうため。タブは開かない）。
fn new_nonce() -> Result<String, String> {
    let mut b = [0u8; 16];
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .map_err(|e| format!("cannot read /dev/urandom: {e}"))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// 送ってよいキーの一覧か。
fn valid_keys(keys: &[KeySpec]) -> bool {
    keys.len() <= MAX_KEYS
        && keys
            .iter()
            .all(|k| !k.key.is_empty() && k.key.len() <= 16 && !k.key.chars().any(char::is_control))
}

/// ページに入れるスクリプト（nonce と受けるキーを埋めたもの）。
fn key_script(nonce: &str, keys: &[KeySpec]) -> String {
    let n = serde_json::to_string(nonce).unwrap_or_else(|_| "\"\"".into());
    let k = serde_json::to_string(keys).unwrap_or_else(|_| "[]".into());
    KEY_SCRIPT
        .replace("__KISUI_NONCE__", &n)
        .replace("__KISUI_KEYS__", &k)
}

/// ページのスクリプトが知らせたキーの URL を読む。nonce が合わない・形が違うものは None。
pub fn parse_key(u: &Url, nonce: &str, tab: &str) -> Option<KeyEvent> {
    if u.scheme() != KEY_SCHEME {
        return None;
    }
    let mut n = None;
    let mut key = None;
    let mut code = String::new();
    let mut mods = None;
    let mut repeat = false;
    for (k, v) in u.query_pairs() {
        match k.as_ref() {
            "n" => n = Some(v.into_owned()),
            "k" => key = Some(v.into_owned()),
            "c" => code = v.into_owned(),
            "m" => mods = v.parse::<u8>().ok(),
            "r" => repeat = v == "1",
            _ => {}
        }
    }
    if n.as_deref() != Some(nonce) || nonce.is_empty() {
        return None;
    }
    let key = key?;
    let mods = mods?;
    if key.is_empty() || key.len() > 32 || code.len() > 32 || mods > 15 {
        return None;
    }
    Some(KeyEvent {
        tab: tab.to_string(),
        key,
        code,
        ctrl_key: mods & 1 != 0,
        shift_key: mods & 2 != 0,
        alt_key: mods & 4 != 0,
        meta_key: mods & 8 != 0,
        repeat,
    })
}

/// メインの webview にキーを向ける（子の webview にあったキーを、kisui-terminal の画面に戻す）。
fn focus_main(app: &AppHandle) {
    if let Some(m) = app.get_webview("main") {
        let _ = m.set_focus();
    }
}

/// ページのデータ（Cookie など）を置くフォルダ。macOS は WKWebView の既定の置き場を使うので None。
#[cfg(not(target_os = "macos"))]
fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    let d = app.path().app_data_dir().ok()?.join(DATA_DIR);
    crate::clipboard_history::create_private_dir(&d).ok()?;
    Some(d)
}

/// 子の webview の中で遷移してよい URL か（http・https・about だけ。file:・javascript:・tauri: などには行かせない）。
fn may_navigate(u: &Url) -> bool {
    matches!(u.scheme(), "http" | "https" | "about")
}

/// 新しい窓として開こうとした URL を、代わりに同じタブで開くか（http・https だけ。新しい窓は #204）。
fn opens_in_same_tab(u: &Url) -> bool {
    matches!(u.scheme(), "http" | "https")
}

/// 子の webview が新しい窓を開こうとした（`target=_blank`・`window.open`）。どれも開かずに断る。
/// ページのスクリプトが知らせたキー（`kisui-key:`。nonce が合うもの）なら、画面に知らせてからキーをメインの webview に移す。
/// ページのスクリプトが知らせたパスキーの求め（`kisui-passkey:`。nonce が合うもの）なら、外のブラウザに移る（passkey.rs）。
/// http・https なら、同じタブで開く。
/// この中は webview の処理の最中なので、知らせる・移す・開くは別のスレッドで行う。
fn on_new_window(app: &AppHandle, tab: &str, nonce: &str, u: Url) -> NewWindowResponse<tauri::Wry> {
    let app = app.clone();
    if let Some(ev) = parse_key(&u, nonce, tab) {
        std::thread::spawn(move || {
            // 先に知らせてからキーを移す（移したあとに画面に届くキーより前に、このキーを届ける）
            let _ = app.emit(EVENT_KEY, ev);
            focus_main(&app);
        });
    } else if passkey::is_request(&u, nonce) {
        // ページがパスキーを求めた（browser_passkey.js）。今の URL が許可サイトなら、外のブラウザで開く（passkey.rs）
        let lbl = label(tab);
        let tab = tab.to_string();
        std::thread::spawn(move || {
            let (Some(p), Some(v)) = (app.try_state::<Arc<Passkey>>(), app.get_webview(&lbl))
            else {
                return;
            };
            let Ok(now) = v.url() else { return };
            if let Some(to) = p.hand_off(&tab, &now, Instant::now()) {
                passkey::open_external(p.browser(), &to);
            }
        });
    } else if opens_in_same_tab(&u) {
        let lbl = label(tab);
        std::thread::spawn(move || {
            if let Some(v) = app.get_webview(&lbl) {
                let _ = v.navigate(u);
            }
        });
    }
    NewWindowResponse::Deny
}

/// タブの子の webview を組む。ページにはキーのスクリプトを入れ、遷移・新しい窓・読み込み・題の変化を受ける。
fn tab_builder(
    app: &AppHandle,
    tab: &str,
    first: Url,
    nonce: String,
    keys: &[KeySpec],
) -> WebviewBuilder<tauri::Wry> {
    let script = key_script(&nonce, keys);
    // パスキーのサイトを設定に書いたときだけ、パスキーを捕まえるスクリプトも入れる（passkey.rs）
    let passkey_script = app
        .try_state::<Arc<Passkey>>()
        .map(|p| passkey::script(&nonce, p.sites()));
    let (win_app, win_tab) = (app.clone(), tab.to_string());
    let (load_app, load_tab) = (app.clone(), tab.to_string());
    let (title_app, title_tab) = (app.clone(), tab.to_string());
    let mut builder = WebviewBuilder::new(label(tab), WebviewUrl::External(first))
        .initialization_script_for_all_frames(script);
    if let Some(s) = passkey_script {
        builder = builder.initialization_script_for_all_frames(s);
    }
    let builder = builder
        .focused(false)
        .on_navigation(may_navigate)
        .on_new_window(move |u, _| on_new_window(&win_app, &win_tab, &nonce, u))
        .on_page_load(move |_, p| {
            let loading = match p.event() {
                PageLoadEvent::Started => true,
                PageLoadEvent::Finished => false,
            };
            let _ = load_app.emit(
                EVENT_PAGE,
                PageEvent {
                    tab: load_tab.clone(),
                    url: p.url().to_string(),
                    loading,
                },
            );
        })
        .on_document_title_changed(move |_, title| {
            let _ = title_app.emit(
                EVENT_TITLE,
                TitleEvent {
                    tab: title_tab.clone(),
                    title,
                },
            );
        });
    #[cfg(not(target_os = "macos"))]
    let builder = match data_dir(app) {
        Some(d) => builder.data_directory(d),
        None => builder,
    };
    builder
}

/// タブを作る（子の webview）。位置と大きさはメイン窓の左上からの論理ピクセル。作るだけで、キーは向けない（`browser_focus`）。
/// `keys` はページにキーがある間も受けるキー（リーダーと近道）。
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn browser_open(
    app: AppHandle,
    webview: Webview,
    tab: String,
    url: String,
    keys: Vec<KeySpec>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    from_main(&webview)?;
    if !valid_tab(&tab) {
        return Err("invalid tab id".into());
    }
    if !valid_keys(&keys) {
        return Err("invalid keys".into());
    }
    let first = parse_url(&url)?;
    let win = app
        .get_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    if app.get_webview(&label(&tab)).is_some() {
        return Err("the tab is already open".into());
    }
    let builder = tab_builder(&app, &tab, first, new_nonce()?, &keys);
    win.add_child(
        builder,
        LogicalPosition::new(x, y),
        LogicalSize::new(w.max(1.0), h.max(1.0)),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// タブの位置と大きさを合わせる（論理ピクセル）。
#[tauri::command]
pub fn browser_bounds(
    app: AppHandle,
    webview: Webview,
    tab: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    from_main(&webview)?;
    let v = child(&app, &tab)?;
    v.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    v.set_size(LogicalSize::new(w.max(1.0), h.max(1.0)))
        .map_err(|e| e.to_string())
}

/// タブを見せる・隠す。隠すときは、キーをメインの webview に戻す（隠れたページにキーが残らないように）。
#[tauri::command]
pub fn browser_visible(
    app: AppHandle,
    webview: Webview,
    tab: String,
    visible: bool,
) -> Result<(), String> {
    from_main(&webview)?;
    let v = child(&app, &tab)?;
    if visible {
        v.show().map_err(|e| e.to_string())
    } else {
        v.hide().map_err(|e| e.to_string())?;
        focus_main(&app);
        Ok(())
    }
}

/// タブのページにキーを向ける。
#[tauri::command]
pub fn browser_focus(app: AppHandle, webview: Webview, tab: String) -> Result<(), String> {
    from_main(&webview)?;
    child(&app, &tab)?.set_focus().map_err(|e| e.to_string())
}

/// タブで URL を開く（`o u`）。
#[tauri::command]
pub fn browser_go(
    app: AppHandle,
    webview: Webview,
    tab: String,
    url: String,
) -> Result<(), String> {
    from_main(&webview)?;
    let v = child(&app, &tab)?;
    v.navigate(parse_url(&url)?).map_err(|e| e.to_string())
}

/// 戻る・進む・読み込み直す。
#[tauri::command]
pub fn browser_nav(
    app: AppHandle,
    webview: Webview,
    tab: String,
    action: String,
) -> Result<(), String> {
    from_main(&webview)?;
    let v = child(&app, &tab)?;
    match action.as_str() {
        "back" => v.eval("history.back()"),
        "forward" => v.eval("history.forward()"),
        "reload" => v.reload(),
        _ => return Err(format!("unknown action: {action:?}")),
    }
    .map_err(|e| e.to_string())
}

/// タブを閉じる（子の webview を壊す）。無ければ何もしない。
#[tauri::command]
pub fn browser_close(app: AppHandle, webview: Webview, tab: String) -> Result<(), String> {
    from_main(&webview)?;
    if !valid_tab(&tab) {
        return Err("invalid tab id".into());
    }
    if let Some(v) = app.get_webview(&label(&tab)) {
        let _ = v.close();
        focus_main(&app);
    }
    Ok(())
}

fn tabs_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(TABS_FILE))
        .map_err(|e| e.to_string())
}

/// 覚えたタブを読む。無い・壊れている・版が違うときは空。
pub fn load_tabs(path: &Path) -> StoredTabs {
    let text = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == ErrorKind::NotFound => return StoredTabs::default(),
        Err(e) => {
            eprintln!("kisui-terminal: cannot read {}: {e}", path.display());
            return StoredTabs::default();
        }
    };
    match serde_json::from_slice::<StoredFile>(&text) {
        Ok(f) if f.version == FORMAT_VERSION => {
            let mut d = f.data;
            d.tabs
                .retain(|t| valid_tab(&t.id) && parse_url(&t.url).is_ok());
            d.tabs.truncate(MAX_TABS);
            d
        }
        _ => StoredTabs::default(),
    }
}

/// タブを覚える（自分だけが読めるファイル。書きかけを残さないよう、別の名前に書いてから置き換える）。
pub fn save_tabs(path: &Path, data: &StoredTabs) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        crate::clipboard_history::create_private_dir(dir)?;
    }
    let body = serde_json::to_vec(&StoredFile {
        version: FORMAT_VERSION,
        data: data.clone(),
    })
    .map_err(std::io::Error::other)?;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let _ = fs::remove_file(&tmp);
    let mut f = crate::clipboard_history::open_private(&tmp)?;
    f.write_all(&body)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, path)
}

/// 開いていたタブ（再起動したときに戻す）。
#[tauri::command]
pub fn browser_tabs_load(app: AppHandle, webview: Webview) -> Result<StoredTabs, String> {
    from_main(&webview)?;
    Ok(load_tabs(&tabs_path(&app)?))
}

/// 開いているタブを覚える。
#[tauri::command(async)]
pub fn browser_tabs_save(app: AppHandle, webview: Webview, data: StoredTabs) -> Result<(), String> {
    from_main(&webview)?;
    if data.tabs.len() > MAX_TABS
        || data.collapsed.len() > MAX_TABS
        || data.tabs.iter().any(|t| {
            !valid_tab(&t.id)
                || t.url.len() > 4096
                || t.title.len() > 4096
                || t.target.len() > 1024
                || t.workspace.len() > 1024
        })
    {
        return Err("invalid tabs".into());
    }
    save_tabs(&tabs_path(&app)?, &data).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_ids() {
        assert!(valid_tab("t1a2b3"));
        assert!(valid_tab("a-b_c"));
        assert!(!valid_tab(""));
        assert!(!valid_tab("a b"));
        assert!(!valid_tab("a/b"));
        assert!(!valid_tab("../x"));
        assert!(!valid_tab(&"x".repeat(33)));
        assert_eq!(label("t1"), "browser-t1");
    }

    fn key_url(q: &str) -> Url {
        Url::parse(&format!("kisui-key://key?{q}")).unwrap()
    }

    #[test]
    fn reads_a_key_with_the_right_nonce() {
        let u = key_url("n=abc&k=K&c=KeyK&m=3&r=0");
        let ev = parse_key(&u, "abc", "t1").unwrap();
        assert_eq!(
            ev,
            KeyEvent {
                tab: "t1".into(),
                key: "K".into(),
                code: "KeyK".into(),
                ctrl_key: true,
                shift_key: true,
                alt_key: false,
                meta_key: false,
                repeat: false,
            }
        );
        let ev = parse_key(&key_url("n=abc&k=%2B&c=Equal&m=8&r=1"), "abc", "t1").unwrap();
        assert_eq!(ev.key, "+");
        assert!(ev.meta_key && ev.repeat && !ev.ctrl_key);
    }

    // ページのスクリプトが nonce を知らずに作った URL は受けない
    #[test]
    fn ignores_keys_without_the_nonce() {
        for q in [
            "k=K&c=KeyK&m=3",
            "n=abd&k=K&c=KeyK&m=3",
            "n=&k=K&c=KeyK&m=3",
            "n=abc&c=KeyK&m=3",
            "n=abc&k=&m=3",
            "n=abc&k=K&m=99",
            "n=abc&k=K",
        ] {
            assert!(parse_key(&key_url(q), "abc", "t1").is_none(), "{q}");
        }
        assert!(parse_key(&key_url("n=&k=K&m=3"), "", "t1").is_none());
        // ほかの scheme は受けない
        let u = Url::parse("https://example.com/?n=abc&k=K&m=3").unwrap();
        assert!(parse_key(&u, "abc", "t1").is_none());
    }

    #[test]
    fn nonces_differ() {
        let a = new_nonce().unwrap();
        let b = new_nonce().unwrap();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn script_has_the_nonce_and_keys() {
        let keys = vec![KeySpec {
            ctrl: true,
            shift: true,
            alt: false,
            meta: false,
            key: "k".into(),
            enter: true,
        }];
        let s = key_script("abc\"</script>", &keys);
        assert!(!s.contains("__KISUI_NONCE__"));
        assert!(!s.contains("__KISUI_KEYS__"));
        // 文字列として埋める（JS の外に出ない）
        assert!(s.contains(r#"const nonce = "abc\"</script>";"#), "{s}");
        assert!(s.contains(r#""key":"k""#));
        assert!(s.contains(r#""enter":true"#));
    }

    #[test]
    fn keys_are_limited() {
        let k = |key: &str| KeySpec {
            ctrl: false,
            shift: false,
            alt: false,
            meta: true,
            key: key.into(),
            enter: false,
        };
        assert!(valid_keys(&[k("k"), k("Enter")]));
        assert!(!valid_keys(&[k("")]));
        assert!(!valid_keys(&[k("a\nb")]));
        assert!(!valid_keys(&vec![k("k"); MAX_KEYS + 1]));
    }

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kisui-browser-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn tabs_round_trip_in_a_private_file() {
        let d = temp_dir("tabs");
        let p = d.join("sub").join(TABS_FILE);
        assert_eq!(load_tabs(&p), StoredTabs::default());
        let data = StoredTabs {
            tabs: vec![StoredTab {
                id: "t1".into(),
                target: "@local".into(),
                workspace: "w1".into(),
                url: "https://example.com/".into(),
                title: "Example".into(),
            }],
            collapsed: vec![StoredWs {
                target: "dev".into(),
                workspace: "w2".into(),
            }],
        };
        save_tabs(&p, &data).unwrap();
        assert_eq!(load_tabs(&p), data);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn broken_or_unsafe_tabs_are_dropped() {
        let d = temp_dir("broken");
        fs::create_dir_all(&d).unwrap();
        let p = d.join(TABS_FILE);
        fs::write(&p, "{").unwrap();
        assert_eq!(load_tabs(&p), StoredTabs::default());
        fs::write(&p, r#"{"version":99,"tabs":[]}"#).unwrap();
        assert_eq!(load_tabs(&p), StoredTabs::default());
        fs::write(
            &p,
            r#"{"version":1,"tabs":[
              {"id":"ok","target":"@local","workspace":"w","url":"https://a.example/"},
              {"id":"bad id","target":"@local","workspace":"w","url":"https://a.example/"},
              {"id":"js","target":"@local","workspace":"w","url":"javascript:alert(1)"},
              {"id":"file","target":"@local","workspace":"w","url":"file:///etc/passwd"}
            ]}"#,
        )
        .unwrap();
        let got = load_tabs(&p);
        assert_eq!(got.tabs.len(), 1);
        assert_eq!(got.tabs[0].id, "ok");
        assert_eq!(got.tabs[0].title, "");
        let _ = fs::remove_dir_all(&d);
    }

    // ページに入れるスクリプトが、殻の受ける URL の形（scheme と項目の名前）で知らせる
    #[test]
    fn script_sends_the_url_this_shell_reads() {
        assert!(KEY_SCRIPT.contains("\"kisui-key://key?n=\""));
        for q in ["\"&k=\"", "\"&c=\"", "\"&m=\"", "\"&r=\""] {
            assert!(KEY_SCRIPT.contains(q), "{q}");
        }
        // 遷移（location）ではなく window.open で知らせる（ページの beforeunload を起こさない）
        assert!(!KEY_SCRIPT.contains("location"));
    }

    // キーの中身は、先に取っておいた getter だけで読む（ページが KeyboardEvent.prototype を差し替えても見せかけられない）。
    // 受けたイベント（ev）から直接読むのは、差し替えられない isTrusted だけ
    #[test]
    fn script_reads_keys_through_saved_getters() {
        assert_eq!(KEY_SCRIPT.matches("ev.").count(), 1);
        assert!(KEY_SCRIPT.contains("ev.isTrusted"));
        for name in [
            "key",
            "code",
            "ctrlKey",
            "shiftKey",
            "altKey",
            "metaKey",
            "repeat",
            "isComposing",
        ] {
            assert!(
                KEY_SCRIPT.contains(&format!("getter(K, \"{name}\")")),
                "{name}"
            );
        }
    }

    // 遷移は http・https・about だけ。新しい窓の代わりに同じタブで開くのは http・https だけ
    #[test]
    fn where_a_tab_may_go() {
        let u = |s: &str| Url::parse(s).unwrap();
        for ok in [
            "https://a.example/",
            "http://localhost:3000/",
            "about:blank",
        ] {
            assert!(may_navigate(&u(ok)), "{ok}");
        }
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tauri://localhost/",
            "kisui-key://key?n=x",
        ] {
            assert!(!may_navigate(&u(bad)), "{bad}");
        }
        assert!(opens_in_same_tab(&u("https://a.example/")));
        assert!(!opens_in_same_tab(&u("about:blank")));
        assert!(!opens_in_same_tab(&u("kisui-key://key?n=x")));
    }
}
