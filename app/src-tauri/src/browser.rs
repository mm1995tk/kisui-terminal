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
//! - 子の webview の遷移は http・https・about だけ許す。
//!
//! ページが開く新しい窓（`target=_blank` のリンク・`window.open`。#204）は、同じワークスペースの新しいタブにする（`open_popup`）。
//! 開いた元のページとの連絡（`window.opener`）を保つには、WebKit が求める形（Linux は元の webview に関係付けた webview、
//! macOS は WebKit が渡す設定で作った webview）で作り、`NewWindowResponse::Create` で返す必要がある。tauri はそれを
//! 「窓の最初の webview」でしか受けないので、隠した窓に子の webview として作って返し、そのあとメイン窓に移して（reparent）
//! 窓を壊す。新しいタブは、開いた元のタブと同じデータ（ログイン）を使う（シークレットのタブから開いたものはシークレット）。
//! ページが自分で閉じたら（`window.close()`）、画面に知らせ、画面はタブを閉じて元のタブに戻る。
//! Linux は WebKitGTK の close を直接受け、macOS はページに入れたスクリプト（browser_close.js）が `kisui-close:` の URL で知らせる。
//! ダウンロードは download.rs。
//!
//! ページにキーがある間も、リーダーと近道を効かせる。キーは IPC では受けない。ページに入れるスクリプト（browser_keys.js）が、
//! 当たるキーを `kisui-key:` の URL にして window.open で開こうとし、ここの on_new_window が受けて画面に渡す（開かずに断る）。
//! URL には webview を作るたびに決める nonce を入れ、合わないものは捨てる（ページのスクリプトが真似できないように）。
//! 設定にパスキーのサイト（`[gui.browser] passkey_sites`）があれば、パスキーを捕まえるスクリプト（browser_passkey.js）も入れ、
//! 同じ形（`kisui-passkey:` の URL と同じ nonce）で知らせを受けて、外のブラウザに移る（passkey.rs。#206）。
//!
//! ログイン（Cookie などのページのデータ）は、すべてのタブで 1 つを共有し、ディスクに残す。Linux はデータのフォルダの
//! `browser/` に置く。macOS は WKWebView の既定の置き場（`~/Library/WebKit/<アプリの id>/` など。場所は OS が決める）を使う。
//! シークレットのタブ（#204）は、タブごとに別の、ディスクに残さないデータを使う（tauri の `incognito`）。パスキーのスクリプトは入れない。
//! 開いていたタブ（ワークスペースと URL）は、データのフォルダの `browser-tabs.json` に覚える（画面が書く。シークレットのタブは書かない）。
//!
//! #205：ページの表示の大きさ（`browser_zoom`。タブごとに、覚えるタブと一緒に覚える）、ページ内検索（`browser_find`）、
//! DevTools（`browser_devtools`）。ブックマークは bookmarks.rs。
//! ページの favicon（サイドバーのタブの行に出す。#237）は favicon.rs。

use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowFeatures, NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewBuilder,
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
/// 1 つのタブが新しい窓を開ける数の上限（POPUP_WINDOW の間に）。ページが window.open を繰り返しても、タブを増やし続けない
/// （macOS の WKWebView は、ユーザーの操作の無い window.open も既定で通す）。
const MAX_POPUPS: usize = 5;
const POPUP_WINDOW: std::time::Duration = std::time::Duration::from_secs(10);

/// ページが自分を閉じたことを殻に知らせる URL の scheme（macOS だけ。browser_close.js）。
const CLOSE_SCHEME: &str = "kisui-close";
/// ページが自分を閉じたら知らせるスクリプト（macOS だけ入れる）。
#[cfg(target_os = "macos")]
const CLOSE_SCRIPT: &str = include_str!("browser_close.js");

/// 画面に知らせるイベント。
const EVENT_KEY: &str = "browser-key";
const EVENT_PAGE: &str = "browser-page";
const EVENT_TITLE: &str = "browser-title";
/// ページが新しい窓を開いた（新しいタブにした）。
const EVENT_POPUP: &str = "browser-popup";
/// ページが自分を閉じた。
const EVENT_CLOSED: &str = "browser-closed";

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

#[derive(Serialize, Clone)]
struct PopupEvent {
    /// 開いた元のタブ
    opener: String,
    /// 新しいタブ（殻が付けた id。webview はもうある）
    tab: String,
    url: String,
}

#[derive(Serialize, Clone)]
struct ClosedEvent {
    tab: String,
}

/// タブ 1 つについて、殻が覚えること（ページが開いた新しい窓のタブに引き継ぐ）。
#[derive(Debug, Clone)]
struct TabInfo {
    keys: Vec<KeySpec>,
    incognito: bool,
    /// ページのスクリプトが殻に知らせる URL の nonce。ページが開いた新しい窓のタブは、開いた元のタブと同じものを使う
    /// （macOS は、ページに入れるスクリプトの入れ物を開いた元と共有するため。`tab_builder`）
    nonce: String,
    /// 新しい窓の数を数える元のタブ（ふつうのタブは自分。ページが開いた新しい窓のタブは、開いた元の root を引き継ぐ。
    /// 新しいタブがそれぞれ自分の上限を持つと、開いた窓がまた開く、を繰り返して増え続けるため）
    root: String,
}

/// 開いているタブ（id → 覚えること）。
#[derive(Default)]
pub struct Tabs {
    tabs: Mutex<HashMap<String, TabInfo>>,
    /// 元のタブ（TabInfo の root）→ その下のタブが新しい窓を開いた時刻（POPUP_WINDOW より前のものは捨てる）
    popups: Mutex<HashMap<String, Vec<Instant>>>,
}

impl Tabs {
    fn get(&self, tab: &str) -> Option<TabInfo> {
        self.tabs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(tab)
            .cloned()
    }

    fn set(&self, tab: &str, info: TabInfo) {
        self.tabs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(tab.to_string(), info);
    }

    /// 元のタブ root の下のタブが、今 (now) 新しい窓を開いてよいか。よければ数える。
    fn allow_popup(&self, root: &str, now: Instant) -> bool {
        let mut m = self.popups.lock().unwrap_or_else(|e| e.into_inner());
        let ok = allow_popup(m.entry(root.to_string()).or_default(), now);
        // 時刻が残っていない元のタブは忘れる（閉じたタブの分が積もらないように）
        m.retain(|_, t| {
            t.retain(|x| now.saturating_duration_since(*x) < POPUP_WINDOW);
            !t.is_empty()
        });
        ok
    }

    fn remove(&self, tab: &str) {
        self.tabs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(tab);
    }
}

/// 新しい窓を開いた時刻の並び times に、今 (now) を足してよいか（POPUP_WINDOW の間に MAX_POPUPS まで）。よければ足す。
fn allow_popup(times: &mut Vec<Instant>, now: Instant) -> bool {
    times.retain(|t| now.saturating_duration_since(*t) < POPUP_WINDOW);
    if times.len() >= MAX_POPUPS {
        return false;
    }
    times.push(now);
    true
}

/// タブのページのデータ（ログイン）をどこに置くか。
enum Data {
    /// すべてのタブで共有し、ディスクに残す
    Shared,
    /// このタブだけの、ディスクに残さないデータ（シークレットのタブ）
    Incognito,
    /// ページが開いた新しい窓。開いた元の webview と同じデータ（WebKit が決める）。
    /// incognito は元のタブがシークレットか（パスキーのスクリプトを入れるかを決める）
    Opener {
        features: NewWindowFeatures,
        incognito: bool,
    },
}

impl Data {
    /// シークレットのデータか（ページが開いた新しい窓は、開いた元のタブがシークレットか）。
    fn incognito(&self) -> bool {
        match self {
            Data::Shared => false,
            Data::Incognito => true,
            Data::Opener { incognito, .. } => *incognito,
        }
    }
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
    /// ページの表示の大きさ（百分率。#205）。元の大きさ（100）なら書かない
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoom: Option<u32>,
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

/// ページが新しい窓として開こうとした URL を、新しいタブで開くか（http・https と about:blank。
/// OAuth の小窓などは、about:blank で開いてから行き先に移ることがある）。
fn opens_in_new_tab(u: &Url) -> bool {
    matches!(u.scheme(), "http" | "https") || u.as_str() == "about:blank"
}

/// ページのスクリプトが知らせた「ページが自分を閉じた」（`kisui-close:`。nonce が合うもの）か（macOS。browser_close.js）。
fn is_close_request(u: &Url, nonce: &str) -> bool {
    u.scheme() == CLOSE_SCHEME
        && !nonce.is_empty()
        && u.query_pairs().any(|(k, v)| k == "n" && v == nonce)
}

/// ページが自分を閉じたことを画面に知らせる（画面はタブを閉じ、元のタブに戻る）。
fn tell_closed(app: &AppHandle, tab: &str) {
    let _ = app.emit(
        EVENT_CLOSED,
        ClosedEvent {
            tab: tab.to_string(),
        },
    );
}

/// 子の webview が新しい窓を開こうとした（`target=_blank`・`window.open`）。
/// ページのスクリプトが知らせたキー（`kisui-key:`。nonce が合うもの）なら、画面に知らせてからキーをメインの webview に移す。
/// ページのスクリプトが知らせたパスキーの求め（`kisui-passkey:`。nonce が合うもの）なら、外のブラウザに移る（passkey.rs）。
/// ページのスクリプトが知らせた「閉じた」（`kisui-close:`。macOS）なら、画面に知らせる。どれも開かずに断る。
/// http・https・about:blank なら、新しいタブにする（`open_popup`）。作れなければ、http・https は同じタブで開く。
/// この中は webview の処理の最中なので、知らせる・移す・開くは別のスレッドで行う（新しいタブを作るのは、ここで行う）。
fn on_new_window(
    app: &AppHandle,
    tab: &str,
    nonce: &str,
    u: Url,
    features: NewWindowFeatures,
) -> NewWindowResponse<tauri::Wry> {
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
    } else if is_close_request(&u, nonce) {
        let tab = tab.to_string();
        std::thread::spawn(move || tell_closed(&app, &tab));
    } else if opens_in_new_tab(&u) {
        match open_popup(&app, tab, &u, features) {
            Ok(r) => return r,
            Err(e) => {
                eprintln!("kisui-terminal: cannot open a new tab for {u}: {e}");
                if u.scheme() != "about" {
                    let lbl = label(tab);
                    std::thread::spawn(move || {
                        if let Some(v) = app.get_webview(&lbl) {
                            let _ = v.navigate(u);
                        }
                    });
                }
            }
        }
    }
    NewWindowResponse::Deny
}

/// ページが開こうとした新しい窓を、新しいタブ（子の webview）として作り、WebKit に返す（`window.opener` を保つ）。
/// tauri の `Create` は窓の最初の webview しか受けないので、隠した窓（ラベルはタブと同じ）に作って返し、
/// 返したあと（別のスレッドで）メイン窓に移して窓を壊し、画面に知らせる（画面は、開いた元のタブのワークスペースに足す）。
/// webview の処理の最中（メインスレッド）に呼ぶ。
fn open_popup(
    app: &AppHandle,
    opener: &str,
    u: &Url,
    features: NewWindowFeatures,
) -> Result<NewWindowResponse<tauri::Wry>, String> {
    let tabs = app.try_state::<Tabs>().ok_or("no tabs")?;
    let info = tabs.get(opener).ok_or("unknown tab")?;
    if !tabs.allow_popup(&info.root, Instant::now()) {
        // 同じタブで開き直すこともしない（繰り返し開くページに、今のページを捨てさせない）
        eprintln!("kisui-terminal: tab {opener} opened too many windows; ignoring {u}");
        return Ok(NewWindowResponse::Deny);
    }
    let main = app.get_window("main").ok_or("no main window")?;
    let id = format!("w{}", &new_nonce()?[..16]);
    let lbl = label(&id);
    let holder = tauri::window::WindowBuilder::new(app, &lbl)
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .build()
        .map_err(|e| e.to_string())?;
    let builder = tab_builder(
        app,
        &id,
        Url::parse("about:blank").map_err(|e| e.to_string())?,
        info.nonce.clone(),
        &info.keys,
        Data::Opener {
            features,
            incognito: info.incognito,
        },
    );
    let v = match holder.add_child(
        builder,
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(800.0, 600.0),
    ) {
        Ok(v) => v,
        Err(e) => {
            let _ = holder.destroy();
            return Err(e.to_string());
        }
    };
    let Some(window) = app.get_webview_window(&lbl) else {
        let _ = v.close();
        let _ = holder.destroy();
        return Err("cannot find the new webview".into());
    };
    // 開いた元と同じ root で数える
    tabs.set(&id, info);
    watch_native(app, &v, &id);
    let (app, opener, url) = (app.clone(), opener.to_string(), u.to_string());
    std::thread::spawn(move || {
        // WebKit が webview を受け取ってから（この関数から戻ってから）移す
        if let Err(e) = v.reparent(&main) {
            eprintln!("kisui-terminal: cannot move the new tab into the window: {e}");
            if let Some(t) = app.try_state::<Tabs>() {
                t.remove(&id);
            }
            let _ = v.close();
            let _ = holder.destroy();
            return;
        }
        let _ = v.hide();
        let _ = holder.destroy();
        let _ = app.emit(
            EVENT_POPUP,
            PopupEvent {
                opener,
                tab: id,
                url,
            },
        );
    });
    Ok(NewWindowResponse::Create { window })
}

/// Linux：WebKitGTK から直接受けるもの（ページの window.close() と、ダウンロード）を足す。
/// wry は window.close() で webview を壊すだけで殻に知らせないので、画面に知らせてタブを閉じさせる。
#[cfg(target_os = "linux")]
fn watch_native(app: &AppHandle, v: &Webview, tab: &str) {
    let (app, tab) = (app.clone(), tab.to_string());
    let _ = v.with_webview(move |pv| {
        use webkit2gtk::WebViewExt;
        let w = pv.inner();
        if let Some(ctx) = w.context() {
            crate::download::watch(&app, &ctx);
        }
        w.connect_close(move |_| tell_closed(&app, &tab));
    });
}

#[cfg(not(target_os = "linux"))]
fn watch_native(_: &AppHandle, _: &Webview, _: &str) {}

/// ページに入れるスクリプト 1 つ。
struct PageScript {
    /// すべてのフレームに入れるか（false なら上のフレームだけ）
    all_frames: bool,
    source: String,
}

/// タブのページに入れるスクリプト（キー・パスキー・macOS の `window.close`）。
fn page_scripts(app: &AppHandle, nonce: &str, keys: &[KeySpec], data: &Data) -> Vec<PageScript> {
    // macOS で、ページが開いた新しい窓は、WebKit が渡す設定（開いた元の設定の写し）で作る。スクリプトの入れ物
    // （WKUserContentController）は開いた元と同じ 1 つなので、ここで足すと開いた元のタブにも入り、重なる。
    // 足さずに、開いた元のタブのスクリプト（同じ nonce）をそのまま使う
    if cfg!(target_os = "macos") && matches!(data, Data::Opener { .. }) {
        return Vec::new();
    }
    let mut out = vec![PageScript {
        all_frames: true,
        source: key_script(nonce, keys),
    }];
    // パスキーのサイトを設定に書いたときだけ、パスキーを捕まえるスクリプトも入れる（passkey.rs）。
    // シークレットのタブには入れない（外のブラウザから写した Cookie は外のブラウザに残り、「残さない」と食い違うため）
    if !data.incognito() {
        if let Some(p) = app.try_state::<Arc<Passkey>>() {
            out.push(PageScript {
                all_frames: true,
                source: passkey::script(nonce, p.sites()),
            });
        }
    }
    #[cfg(target_os = "macos")]
    out.push(PageScript {
        all_frames: false,
        source: CLOSE_SCRIPT.replace(
            "__KISUI_NONCE__",
            &serde_json::to_string(nonce).unwrap_or_else(|_| "\"\"".into()),
        ),
    });
    out
}

/// 遷移・新しい窓・読み込み・題の変化・ダウンロード（macOS）の受け口を足す。
fn with_handlers(
    builder: WebviewBuilder<tauri::Wry>,
    app: &AppHandle,
    tab: &str,
    nonce: String,
) -> WebviewBuilder<tauri::Wry> {
    let (win_app, win_tab) = (app.clone(), tab.to_string());
    let (load_app, load_tab) = (app.clone(), tab.to_string());
    let (title_app, title_tab) = (app.clone(), tab.to_string());
    // favicon（#237）：読み込みの終わりと、読み込みの後の題の変化のたびに読みに行く（読み込み中は頼まない）。読み込みが始まったら、それまでの答えを捨てる
    let page = crate::favicon::Page::default();
    let title_page = page.clone();
    #[cfg(target_os = "macos")]
    let builder = {
        let dl_app = app.clone();
        builder.on_download(move |_, ev| crate::download::on_download(&dl_app, ev))
    };
    builder
        .on_navigation(may_navigate)
        .on_new_window(move |u, f| on_new_window(&win_app, &win_tab, &nonce, u, f))
        .on_page_load(move |w, p| {
            let loading = match p.event() {
                PageLoadEvent::Started => true,
                PageLoadEvent::Finished => false,
            };
            if loading {
                page.started();
            } else {
                page.finished();
            }
            let _ = load_app.emit(
                EVENT_PAGE,
                PageEvent {
                    tab: load_tab.clone(),
                    url: p.url().to_string(),
                    loading,
                },
            );
            if !loading {
                crate::favicon::request(&load_app, &w, &load_tab, &page);
            }
        })
        .on_document_title_changed(move |w, title| {
            crate::favicon::request(&title_app, &w, &title_tab, &title_page);
            let _ = title_app.emit(
                EVENT_TITLE,
                TitleEvent {
                    tab: title_tab.clone(),
                    title,
                },
            );
        })
}

/// ページのデータ（ログイン）の置き場を当てる。
fn with_data(
    builder: WebviewBuilder<tauri::Wry>,
    #[allow(unused_variables)] app: &AppHandle,
    data: Data,
) -> WebviewBuilder<tauri::Wry> {
    match data {
        Data::Shared => {
            #[cfg(not(target_os = "macos"))]
            if let Some(d) = data_dir(app) {
                return builder.data_directory(d);
            }
            builder
        }
        Data::Incognito => builder.incognito(true),
        // 開いた元の webview と同じデータ・同じ処理の中で作る（WebKit が求める）
        Data::Opener { features, .. } => {
            #[cfg(target_os = "linux")]
            let builder = builder.with_related_view(features.opener().webview.clone());
            #[cfg(target_os = "macos")]
            let builder =
                builder.with_webview_configuration(features.opener().target_configuration.clone());
            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            let _ = features;
            builder
        }
    }
}

/// タブの子の webview を組む。ページにスクリプトを入れ、受け口を足し、データの置き場を当てる。
fn tab_builder(
    app: &AppHandle,
    tab: &str,
    first: Url,
    nonce: String,
    keys: &[KeySpec],
    data: Data,
) -> WebviewBuilder<tauri::Wry> {
    // DevTools（`o i`。#205）はタブのページで使う（メインの webview は、release では main.rs で切る）
    let mut builder = WebviewBuilder::new(label(tab), WebviewUrl::External(first))
        .focused(false)
        .devtools(true);
    for s in page_scripts(app, &nonce, keys, &data) {
        builder = if s.all_frames {
            builder.initialization_script_for_all_frames(s.source)
        } else {
            builder.initialization_script(s.source)
        };
    }
    let builder = with_handlers(builder, app, tab, nonce);
    with_data(builder, app, data)
}

/// タブを作る（子の webview）。位置と大きさはメイン窓の左上からの論理ピクセル。作るだけで、キーは向けない（`browser_focus`）。
/// `keys` はページにキーがある間も受けるキー（リーダーと近道）。`incognito` はシークレットのタブ（#204）。
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn browser_open(
    app: AppHandle,
    webview: Webview,
    tabs: State<Tabs>,
    tab: String,
    url: String,
    keys: Vec<KeySpec>,
    incognito: bool,
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
    let data = if incognito {
        Data::Incognito
    } else {
        Data::Shared
    };
    let nonce = new_nonce()?;
    let builder = tab_builder(&app, &tab, first, nonce.clone(), &keys, data);
    let v = win
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(w.max(1.0), h.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    tabs.set(
        &tab,
        TabInfo {
            keys,
            incognito,
            nonce,
            root: tab.clone(),
        },
    );
    watch_native(&app, &v, &tab);
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
pub fn browser_close(
    app: AppHandle,
    webview: Webview,
    tabs: State<Tabs>,
    tab: String,
) -> Result<(), String> {
    from_main(&webview)?;
    if !valid_tab(&tab) {
        return Err("invalid tab id".into());
    }
    tabs.remove(&tab);
    if let Some(v) = app.get_webview(&label(&tab)) {
        let _ = v.close();
        focus_main(&app);
    }
    Ok(())
}

/// ページの表示の大きさの範囲（倍率。#205）。画面が選ぶ段（app/src/scale.ts の SCALES）より広く受ける。
const MIN_ZOOM: f64 = 0.25;
const MAX_ZOOM: f64 = 5.0;

fn valid_zoom(z: f64) -> bool {
    z.is_finite() && (MIN_ZOOM..=MAX_ZOOM).contains(&z)
}

fn valid_zoom_percent(z: u32) -> bool {
    valid_zoom(f64::from(z) / 100.0)
}

/// ページの表示の大きさを変える（1 が元の大きさ。#205。ブラウザを出している間の、リーダーの `v` のグループ）。
#[tauri::command]
pub fn browser_zoom(
    app: AppHandle,
    webview: Webview,
    tab: String,
    zoom: f64,
) -> Result<(), String> {
    from_main(&webview)?;
    if !valid_zoom(zoom) {
        return Err(format!("invalid zoom: {zoom}"));
    }
    child(&app, &tab)?.set_zoom(zoom).map_err(|e| e.to_string())
}

/// ページ内検索で探す字の長さの上限（バイト）。
const MAX_FIND: usize = 1000;
/// ページ内検索の答えを待つ時間。
const FIND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// ページ内検索のスクリプト。WebKit の `window.find` で、今の選択の先（back なら前）を探し、端では折り返す。
/// again でなければ（探す字を変えた）、今の選択の頭から探し直す（打ち足しても、同じ所に留まる）。
/// 探す字は JSON の文字列として埋める（JS の外に出ない）。
fn find_script(text: &str, again: bool, back: bool) -> String {
    let q = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    let restart = !again;
    format!(
        "(() => {{ try {{ const s = window.getSelection(); \
         if ({restart} && s && s.rangeCount > 0) s.collapseToStart(); \
         return !!window.find({q}, false, {back}, true, false, false, false); \
         }} catch (e) {{ return false; }} }})()"
    )
}

/// ページ内を探す（#205。リーダーの `o /`）。mode は `first`（探す字を変えた）・`next`・`prev`。見つかったかを返す。
/// 見つけた所はページの選択になり、そこまでスクロールする。
#[tauri::command(async)]
pub fn browser_find(
    app: AppHandle,
    webview: Webview,
    tab: String,
    text: String,
    mode: String,
) -> Result<bool, String> {
    from_main(&webview)?;
    if text.is_empty() || text.len() > MAX_FIND {
        return Err("invalid text".into());
    }
    let (again, back) = match mode.as_str() {
        "first" => (false, false),
        "next" => (true, false),
        "prev" => (true, true),
        _ => return Err(format!("unknown mode: {mode:?}")),
    };
    let v = child(&app, &tab)?;
    let (tx, rx) = std::sync::mpsc::channel();
    v.eval_with_callback(find_script(&text, again, back), move |r| {
        let _ = tx.send(r);
    })
    .map_err(|e| e.to_string())?;
    let r = rx
        .recv_timeout(FIND_TIMEOUT)
        .map_err(|_| "the page did not answer".to_string())?;
    Ok(r.trim() == "true")
}

/// タブのページの DevTools（Web Inspector）を開く（#205。リーダーの `o i`）。
#[tauri::command]
pub fn browser_devtools(app: AppHandle, webview: Webview, tab: String) -> Result<(), String> {
    from_main(&webview)?;
    child(&app, &tab)?.open_devtools();
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
            // URL が空のタブは、まだ何も開いていない新しいタブのページ（#238）
            d.tabs
                .retain(|t| valid_tab(&t.id) && (t.url.is_empty() || parse_url(&t.url).is_ok()));
            for t in &mut d.tabs {
                t.zoom = t.zoom.filter(|z| valid_zoom_percent(*z));
            }
            d.tabs.truncate(MAX_TABS);
            d
        }
        _ => StoredTabs::default(),
    }
}

/// タブを覚える（自分だけが読めるファイル。書きかけを残さないよう、別の名前に書いてから置き換える）。
pub fn save_tabs(path: &Path, data: &StoredTabs) -> std::io::Result<()> {
    let body = serde_json::to_vec(&StoredFile {
        version: FORMAT_VERSION,
        data: data.clone(),
    })
    .map_err(std::io::Error::other)?;
    write_private(path, &body)
}

/// body を、自分だけが読めるファイル path に書く（書きかけを残さないよう、別の名前に書いてから置き換える）。
pub(crate) fn write_private(path: &Path, body: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        crate::clipboard_history::create_private_dir(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let _ = fs::remove_file(&tmp);
    let mut f = crate::clipboard_history::open_private(&tmp)?;
    f.write_all(body)?;
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
                || t.zoom.is_some_and(|z| !valid_zoom_percent(z))
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
                zoom: Some(125),
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
              {"id":"file","target":"@local","workspace":"w","url":"file:///etc/passwd"},
              {"id":"new","target":"@local","workspace":"w","url":""}
            ]}"#,
        )
        .unwrap();
        let got = load_tabs(&p);
        // URL が空のタブは、新しいタブのページ（#238）として残す
        assert_eq!(got.tabs.len(), 2);
        assert_eq!(got.tabs[0].id, "ok");
        assert_eq!(got.tabs[1].id, "new");
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

    // 遷移は http・https・about だけ。新しい窓を新しいタブで開くのは http・https と about:blank だけ
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
        assert!(opens_in_new_tab(&u("https://a.example/")));
        assert!(opens_in_new_tab(&u("about:blank")));
        assert!(!opens_in_new_tab(&u("about:srcdoc")));
        assert!(!opens_in_new_tab(&u("file:///etc/passwd")));
        assert!(!opens_in_new_tab(&u("kisui-key://key?n=x")));
        assert!(!opens_in_new_tab(&u("kisui-close://close?n=x")));
    }

    // 1 つのタブが新しい窓を開けるのは、POPUP_WINDOW の間に MAX_POPUPS まで
    #[test]
    fn popups_are_limited() {
        let t0 = Instant::now();
        let mut times = Vec::new();
        for _ in 0..MAX_POPUPS {
            assert!(allow_popup(&mut times, t0));
        }
        assert!(!allow_popup(&mut times, t0));
        assert!(!allow_popup(&mut times, t0 + POPUP_WINDOW / 2));
        // 時間が経てば、また開ける
        assert!(allow_popup(&mut times, t0 + POPUP_WINDOW));
        assert_eq!(times.len(), 1);
    }

    // 開いた新しいタブは、開いた元と同じ上限を使う（新しいタブがそれぞれ 5 つ開けると、増え続ける）
    #[test]
    fn popups_count_against_the_first_tab() {
        let tabs = Tabs::default();
        let t0 = Instant::now();
        for _ in 0..MAX_POPUPS {
            assert!(tabs.allow_popup("t1", t0));
        }
        assert!(!tabs.allow_popup("t1", t0));
        // ほかの元のタブは別に数える
        assert!(tabs.allow_popup("t2", t0));
        // 時間が経った元のタブは忘れる
        assert!(tabs.allow_popup("t2", t0 + POPUP_WINDOW));
        assert!(!tabs.popups.lock().unwrap().contains_key("t1"));
    }

    // ページが自分を閉じた知らせは、nonce が合うものだけ受ける
    #[test]
    fn close_requests_need_the_nonce() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(is_close_request(&u("kisui-close://close?n=abc"), "abc"));
        assert!(!is_close_request(&u("kisui-close://close?n=abd"), "abc"));
        assert!(!is_close_request(&u("kisui-close://close"), "abc"));
        assert!(!is_close_request(&u("kisui-close://close?n="), ""));
        assert!(!is_close_request(&u("https://a.example/?n=abc"), "abc"));
    }

    // 表示の大きさは 25%〜500% だけ受ける。覚えたタブの範囲の外の値は捨てる（タブは残す）
    #[test]
    fn zoom_is_limited() {
        assert!(valid_zoom(1.0) && valid_zoom(0.25) && valid_zoom(5.0));
        assert!(!valid_zoom(0.1) && !valid_zoom(6.0) && !valid_zoom(f64::NAN));
        assert!(valid_zoom_percent(70) && !valid_zoom_percent(0));
        let d = temp_dir("zoom");
        fs::create_dir_all(&d).unwrap();
        let p = d.join(TABS_FILE);
        fs::write(
            &p,
            r#"{"version":1,"tabs":[
              {"id":"a","target":"@local","workspace":"w","url":"https://a.example/","zoom":150},
              {"id":"b","target":"@local","workspace":"w","url":"https://a.example/","zoom":9000}
            ]}"#,
        )
        .unwrap();
        let got = load_tabs(&p);
        assert_eq!(got.tabs[0].zoom, Some(150));
        assert_eq!(got.tabs[1].zoom, None);
        // 元の大きさのタブは zoom を書かない
        let body = serde_json::to_string(&got.tabs[1]).unwrap();
        assert!(!body.contains("zoom"), "{body}");
        let _ = fs::remove_dir_all(&d);
    }

    // ページ内検索のスクリプトは、探す字を JS の文字列として埋め、向きと探し直しを入れる
    #[test]
    fn find_script_embeds_the_text_as_a_string() {
        let s = find_script("a\"); alert(1); (\"", false, false);
        assert!(
            s.contains(r#"window.find("a\"); alert(1); (\"", false, false, true"#),
            "{s}"
        );
        assert!(s.contains("if (true && s"), "{s}");
        let s = find_script("x", true, true);
        assert!(s.contains(r#"window.find("x", false, true, true"#), "{s}");
        assert!(s.contains("if (false && s"), "{s}");
    }

    // 閉じた知らせのスクリプトは、殻の受ける URL の形で知らせ、nonce の印を持つ
    #[test]
    fn close_script_sends_the_url_this_shell_reads() {
        let s = include_str!("browser_close.js");
        assert!(s.contains("\"kisui-close://close?n=\""));
        assert!(s.contains("__KISUI_NONCE__"));
        assert!(!s.contains("location"));
    }
}
