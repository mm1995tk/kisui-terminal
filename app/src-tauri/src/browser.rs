//! 内蔵ブラウザのタブ（#202）。設計書 docs/design/browser-and-proxy.md の「GUI の内蔵ブラウザ（入れ直し）」。
//!
//! タブ 1 つにつき、メイン窓の上に重ねる子の webview を 1 つ持つ（OS の WebView。macOS は WKWebView、Linux は WebKitGTK）。
//! 外のサイトの多くは `iframe` に出せない（X-Frame-Options・CSP の frame-ancestors）ので、`<iframe>` は使わない。
//! どこに重ねるか・見せるか隠すかは画面（`app/src/ui/main-window/content/browser/BrowserArea.tsx`）が決め、ここはその通りに置く。
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
//! Linux は WebKitGTK の close を直接受け、macOS はページに入れたスクリプト（browser_close.js・browser_close_tell.js）が
//! `kisui-close:` の URL で知らせる。
//! ダウンロードは download.rs。
//!
//! ページにキーがある間も、リーダーと近道を効かせる。キーは IPC では受けない。ページに入れるスクリプト（browser_keys.js）が、
//! 当たるキーを `kisui-key:` の URL にして window.open で開こうとし、ここの on_new_window が受けて画面に渡す（開かずに断る）。
//! URL には webview を作るたびに決める nonce を入れ、合わないものは捨てる（ページのスクリプトが真似できないように）。
//! nonce を持つスクリプトは、ページの外の世界（isolated world。Linux は WebKitGTK の world、macOS は WKContentWorld）で動かす
//! （`add_world_scripts`）。ページの世界では、ページのスクリプトが組み込みの関数を差し替えた後に、差し込んだスクリプトが
//! もう一度動くことがあり、nonce を守れないため。ページの世界で動かす必要があるスクリプト（ページが呼ぶ関数を
//! 差し替えるもの）は nonce を持たず、外の世界のスクリプトにイベントで知らせる。
//! nonce が合っても、受けるのは登録してあるキー（リーダーと近道）と、リーダーに入った直後の続きのキーだけ（`accept_key`）。
//! 設定にパスキーのサイト（`[gui.browser] passkey_sites`）があれば、パスキーを捕まえるスクリプト（browser_passkey.js・
//! browser_passkey_tell.js）も入れ、同じ形（`kisui-passkey:` の URL と同じ nonce）で知らせを受けて、外のブラウザに移る
//! （passkey.rs。#206）。
//!
//! ログイン（Cookie などのページのデータ）は、すべてのタブで 1 つを共有し、ディスクに残す。Linux はデータのフォルダの
//! `browser/` に置く。macOS は WKWebView の既定の置き場（`~/Library/WebKit/<アプリの id>/` など。場所は OS が決める）を使う。
//! シークレットのタブ（#204）は、タブごとに別の、ディスクに残さないデータを使う（tauri の `incognito`）。パスキーのスクリプトは入れない。
//! 開いていたタブ（ワークスペースと URL）は、データのフォルダの `browser-tabs.json` に覚える（画面が書く。シークレットのタブは書かない）。
//! macOS では、全部のタブ（シークレットのタブ・新しい窓のタブも）を、手元で動かす中継型のプロキシに通す（browser_proxy.rs。#294）。
//! 初めてのタブを開く前に用意し（`browser_open`。証明書の信頼を聞くことがある）、データストアに当てる。
//!
//! #205：ページの表示の大きさ（`browser_zoom`。タブごとに、覚えるタブと一緒に覚える）、ページ内検索（`browser_find`）、
//! DevTools（`browser_devtools`）。ブックマークは bookmarks.rs。
//! #276：パスキーを待たずに、今のタブのサイトを外のブラウザで開いてログインを待つ（`browser_passkey_login`。passkey.rs）。
//! ページの favicon（サイドバーのタブの行に出す。#237）は favicon.rs。

use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowFeatures, NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewBuilder,
    WebviewUrl,
};

use crate::browser_frame::Placement;
use crate::open_url::{from_main, parse_url};
use crate::passkey::{self, Passkey};

/// 子の webview のラベルの頭（画面が決めたタブの id を後ろに付ける）。
const LABEL_PREFIX: &str = "browser-";
/// キーを殻に知らせる URL の scheme。
const KEY_SCHEME: &str = "kisui-key";
/// ページに入れるスクリプト（ページの外の世界で動かす）。
const KEY_SCRIPT: &str = include_str!("browser_keys.js");
/// nonce を持つスクリプトを動かす、ページの外の世界の名前（ページの世界とも、favicon.rs の世界とも別）。
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
const WORLD: &str = "kisui-page";
/// リーダーに入るキーのあと、登録していないキーも続きのキーとして受ける長さ。browser_keys.js が続きのキーを送る長さ
/// （1.5 秒）に、知らせが届くまでの遅れの分を足す（短いと、ページが止めて送ったキーを、ここで捨ててしまう）。
const FOLLOW: Duration = Duration::from_millis(2000);
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
const POPUP_WINDOW: Duration = Duration::from_secs(10);

/// ページが自分を閉じたことを殻に知らせる URL の scheme（macOS だけ。browser_close_tell.js）。
const CLOSE_SCHEME: &str = "kisui-close";
/// ページの window.close を差し替えるスクリプト（macOS だけ入れる。ページの世界で動かす。nonce は持たない）。
#[cfg(target_os = "macos")]
const CLOSE_SCRIPT: &str = include_str!("browser_close.js");
/// ページが自分を閉じたら殻に知らせるスクリプト（macOS だけ入れる。ページの外の世界で動かす）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const CLOSE_TELL_SCRIPT: &str = include_str!("browser_close_tell.js");

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
    /// 通信を記録するプロキシ（#409）に通したタブか。ページが開いた新しい窓のタブは、開いた元と同じデータを使うので、
    /// 開いた元のものを引き継ぐ（browser_load.rs が、プロキシの失敗の応答を、読み込みの失敗として扱う）
    proxied: bool,
}

/// 開いているタブ（id → 覚えること）。
#[derive(Default)]
pub struct Tabs {
    tabs: Mutex<HashMap<String, TabInfo>>,
    /// 元のタブ（TabInfo の root）→ その下のタブが新しい窓を開いた時刻（POPUP_WINDOW より前のものは捨てる）
    popups: Mutex<HashMap<String, Vec<Instant>>>,
    /// タブ → 登録していないキーも、リーダーの続きのキーとして受ける期限（`accept_key`）
    follow: Mutex<HashMap<String, Instant>>,
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

    /// tab が、その元のタブ（root）の下に残った最後のタブなら、root を返す。
    #[cfg(target_os = "macos")]
    fn last_of_root(&self, tab: &str) -> Option<String> {
        let m = self.tabs.lock().unwrap_or_else(|e| e.into_inner());
        let root = &m.get(tab)?.root;
        m.iter()
            .all(|(id, info)| id == tab || info.root != *root)
            .then(|| root.clone())
    }

    fn remove(&self, tab: &str) {
        self.tabs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(tab);
        self.follow
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(tab);
    }

    /// タブ tab のページのスクリプトが知らせたキー ev を、今 (now) 受けてよいか（`accept_key`）。知らないタブのキーは受けない。
    fn accept_key(&self, tab: &str, ev: &KeyEvent, now: Instant) -> bool {
        let Some(info) = self.get(tab) else {
            return false;
        };
        let mut m = self.follow.lock().unwrap_or_else(|e| e.into_inner());
        let mut until = m.get(tab).copied();
        let ok = accept_key(&info.keys, &mut until, ev, now);
        match until {
            Some(t) => m.insert(tab.to_string(), t),
            None => m.remove(tab),
        };
        ok
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
    /// macOS で、内蔵ブラウザのプロキシ（browser_proxy.rs。#294）を使うシークレットのタブ。
    /// このタブだけの、ディスクに残さないデータストアに、プロキシを当てた WebView の設定
    #[cfg(target_os = "macos")]
    ProxiedIncognito(crate::browser_proxy::PrivateConfiguration),
    /// 通信を記録するプロキシ（browser_capture.rs。#409）に通すタブ。このタブだけの、ディスクに残さないデータに、
    /// プロキシを当てる（Linux はプロキシの URL、macOS はプロキシを当てた WebView の設定）
    #[cfg(target_os = "linux")]
    Captured(Url),
    #[cfg(target_os = "macos")]
    Captured(crate::browser_capture::Configuration),
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
            #[cfg(target_os = "macos")]
            Data::ProxiedIncognito(_) => true,
            // 共有のログインを使わないので、シークレットと同じに扱う（パスキーのスクリプトを入れない）
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            Data::Captured(_) => true,
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

/// ページに入れるスクリプト（nonce と受けるキーを埋めたもの。ページの外の世界で動かす）。
fn key_script(nonce: &str, keys: &[KeySpec]) -> String {
    let n = serde_json::to_string(nonce).unwrap_or_else(|_| "\"\"".into());
    let k = serde_json::to_string(keys).unwrap_or_else(|_| "[]".into());
    KEY_SCRIPT
        .replace("__KISUI_NONCE__", &n)
        .replace("__KISUI_KEYS__", &k)
}

/// ページが自分を閉じたら殻に知らせるスクリプト（nonce を埋めたもの。macOS だけ入れる。ページの外の世界で動かす）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn close_tell_script(nonce: &str) -> String {
    CLOSE_TELL_SCRIPT.replace(
        "__KISUI_NONCE__",
        &serde_json::to_string(nonce).unwrap_or_else(|_| "\"\"".into()),
    )
}

/// ページのスクリプトが知らせたキーの URL を読む。nonce が合わない・形が違うものは None。
/// 読めたキーを画面に渡してよいかは、`accept_key` が決める。
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

/// 押されたキー（key と code）が、キーの名前 k（KeySpec の key）のキーか。browser_keys.js の isKey・
/// app/src/features/commands/keyspec.ts の isKey と同じ決まり。
fn is_key(key: &str, code: &str, k: &str) -> bool {
    match k {
        "+" | "=" => key == "+" || key == "=" || code == "Equal" || code == "NumpadAdd",
        "-" => key == "-" || code == "Minus" || code == "NumpadSubtract",
        "Enter" | "Tab" | "Escape" | "Backspace" => key == k,
        "Space" => key == " " || code == "Space",
        _ => {
            let mut cs = k.chars();
            match (cs.next(), cs.next()) {
                (Some(c), None) if c.is_ascii_digit() => {
                    key == k || code == format!("Digit{c}") || code == format!("Numpad{c}")
                }
                (Some(c), None) if c.is_ascii_lowercase() => {
                    key.to_lowercase() == k || code == format!("Key{}", c.to_ascii_uppercase())
                }
                _ => key == k,
            }
        }
    }
}

/// ページで押されたキー ev が、登録してあるキー s に当たるか。browser_keys.js の match・keyspec.ts の matchSpec と同じ決まり
/// （`+` と `=` は Shift を見ない）。
fn key_matches(ev: &KeyEvent, s: &KeySpec) -> bool {
    if ev.ctrl_key != s.ctrl || ev.alt_key != s.alt || ev.meta_key != s.meta {
        return false;
    }
    let plus = s.key == "+" || s.key == "=";
    if !plus && ev.shift_key != s.shift {
        return false;
    }
    is_key(&ev.key, &ev.code, &s.key)
}

/// 修飾キーだけのキーか（browser_keys.js の modifierOnly と同じ。続きのキーとして受けない）。
fn modifier_only(key: &str) -> bool {
    matches!(
        key,
        "Shift" | "Control" | "Alt" | "Meta" | "AltGraph" | "CapsLock" | "OS"
    )
}

/// ページのスクリプトが知らせたキー ev（nonce は合っている）を、今 (now) 画面に渡してよいか。
/// 渡すのは、登録してあるキー keys（リーダーと近道）に当たるものと、リーダーに入るキー（`enter`）のあと `FOLLOW` の間の
/// 続きのキーだけ（browser_keys.js が送るものと同じ。続きのキーは、キーが画面に移る前にページに届いた分）。ほかは捨てる。
/// nonce がページのスクリプトに知られても、登録していないキーをいきなり画面に渡させないため。ただし、リーダーに入るキーの
/// あとの続きのキーは選べないので、nonce を知ったページは、リーダーの木の操作を動かせる（nonce を読ませないことで防ぐ）。
/// follow_until は、続きのキーを受ける期限（タブごとに覚える）。
fn accept_key(
    keys: &[KeySpec],
    follow_until: &mut Option<Instant>,
    ev: &KeyEvent,
    now: Instant,
) -> bool {
    let following = follow_until.is_some_and(|t| now <= t);
    if !following {
        *follow_until = None;
    }
    match keys.iter().find(|k| key_matches(ev, k)) {
        Some(k) => {
            if k.enter {
                *follow_until = Some(now + FOLLOW);
            }
            true
        }
        None if following && !modifier_only(&ev.key) => {
            *follow_until = Some(now + FOLLOW);
            true
        }
        None => false,
    }
}

/// ページのスクリプトが知らせた「Esc が押された」（`kisui-key://esc`。nonce が合うもの）か（browser_keys.js）。
fn is_escape_notice(u: &Url, nonce: &str) -> bool {
    u.scheme() == KEY_SCHEME
        && u.host_str() == Some("esc")
        && !nonce.is_empty()
        && u.query_pairs().any(|(k, v)| k == "n" && v == nonce)
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

/// ページのスクリプトが知らせた「ページが自分を閉じた」（`kisui-close:`。nonce が合うもの）か（macOS。browser_close_tell.js）。
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
/// ページのスクリプトが知らせたキー（`kisui-key:`。nonce が合うもの）なら、画面に知らせてからキーをメインの webview に移す
/// （登録してあるキーと、リーダーの続きのキーだけ。`accept_key`。ほかは捨てる）。
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
        // 登録していないキーは、画面に渡さず、キーも移さない
        let ok = app
            .try_state::<Tabs>()
            .is_some_and(|t| t.accept_key(tab, &ev, Instant::now()));
        if ok {
            std::thread::spawn(move || {
                // 先に知らせてからキーを移す（移したあとに画面に届くキーより前に、このキーを届ける）
                let _ = app.emit(EVENT_KEY, ev);
                focus_main(&app);
            });
        }
    } else if is_escape_notice(&u, nonce) {
        // ページで Esc が押された（browser_keys.js）。止めるかは画面が決める。キーは移さない（ページも Esc を受ける）
        let tab = tab.to_string();
        std::thread::spawn(move || {
            let _ = app.emit(
                crate::browser_progress::EVENT_ESCAPE,
                crate::browser_progress::Escape { tab },
            );
        });
    } else if passkey::is_request(&u, nonce) {
        // ページがパスキーを求めた（browser_passkey_tell.js）。今の URL が許可サイトなら、外のブラウザで開く（passkey.rs）
        let lbl = label(tab);
        let tab = tab.to_string();
        std::thread::spawn(move || {
            let (Some(p), Some(v)) = (app.try_state::<Arc<Passkey>>(), app.get_webview(&lbl))
            else {
                return;
            };
            let Ok(now) = v.url() else { return };
            if let Some(to) = p.hand_off(&tab, &now, Instant::now()) {
                passkey::open_external(&to);
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
    let (builder, world_scripts) = tab_builder(
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
    // WebKit に返す前（ページが読み込まれる前）に足す
    add_world_scripts(&v, world_scripts);
    let Some(window) = app.get_webview_window(&lbl) else {
        let _ = v.close();
        let _ = holder.destroy();
        return Err("cannot find the new webview".into());
    };
    // 開いた元と同じ root で数える
    let proxied = info.proxied;
    tabs.set(&id, info);
    watch_native(app, &v, &id, proxied);
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

/// Linux：WebKitGTK から直接受けるもの（ページの window.close()・ダウンロード・読み込みの失敗）を足す。
/// wry は window.close() で webview を壊すだけで殻に知らせないので、画面に知らせてタブを閉じさせる。
/// 読み込みの失敗（証明書・名前・接続）も wry は知らせないので、画面に知らせる（browser_load.rs。#432）。
/// `proxied` は、プロキシ（#409）に通したタブか（プロキシの失敗の応答も、読み込みの失敗として知らせる）。
#[cfg(target_os = "linux")]
fn watch_native(app: &AppHandle, v: &Webview, tab: &str, proxied: bool) {
    let (app, tab) = (app.clone(), tab.to_string());
    let _ = v.with_webview(move |pv| {
        use webkit2gtk::WebViewExt;
        let w = pv.inner();
        if let Some(ctx) = w.context() {
            crate::download::watch(&app, &ctx);
        }
        crate::browser_load::watch(&app, &w, &tab, proxied);
        w.connect_close(move |_| tell_closed(&app, &tab));
    });
}

/// macOS：読み込みの失敗（証明書・名前・接続）を知らせる先として、タブの WKWebView を覚える（browser_load.rs。#432）。
#[cfg(target_os = "macos")]
fn watch_native(app: &AppHandle, v: &Webview, tab: &str, proxied: bool) {
    let (app, tab) = (app.clone(), tab.to_string());
    let _ = v.with_webview(move |pv| {
        if let Some((w, _)) = wk_webview(&pv) {
            crate::browser_load::register(&app, w, &tab, proxied);
        }
    });
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn watch_native(_: &AppHandle, _: &Webview, _: &str, _: bool) {}

/// ページに入れるスクリプト 1 つ。
struct PageScript {
    /// すべてのフレームに入れるか（false なら上のフレームだけ）
    all_frames: bool,
    /// ページの外の世界（`WORLD`）で動かすか（false ならページの世界）。nonce を持つスクリプトは、必ず外の世界で動かす
    /// （ページのスクリプトは、ページの世界で動くスクリプトの中身を読める）
    isolated: bool,
    source: String,
}

/// タブのページに入れるスクリプト（キー・パスキー・macOS の `window.close`）。
/// `passkey_sites` は、パスキーのサイト（設定に書いたときだけ。passkey.rs）。
fn page_scripts(
    nonce: &str,
    keys: &[KeySpec],
    passkey_sites: Option<&[String]>,
    data: &Data,
) -> Vec<PageScript> {
    // macOS で、ページが開いた新しい窓は、WebKit が渡す設定（開いた元の設定の写し）で作る。スクリプトの入れ物
    // （WKUserContentController）は開いた元と同じ 1 つなので、ここで足すと開いた元のタブにも入り、重なる。
    // 足さずに、開いた元のタブのスクリプト（同じ nonce）をそのまま使う
    if cfg!(target_os = "macos") && matches!(data, Data::Opener { .. }) {
        return Vec::new();
    }
    let mut out = vec![PageScript {
        all_frames: true,
        isolated: true,
        source: key_script(nonce, keys),
    }];
    // パスキーのサイトを設定に書いたときだけ、パスキーを捕まえるスクリプトも入れる（passkey.rs）。
    // シークレットのタブには入れない（外のブラウザから写した Cookie は外のブラウザに残り、「残さない」と食い違うため）。
    // 捕まえるスクリプトはページの世界で動かし（ページが呼ぶ navigator.credentials を差し替える）、殻に知らせるスクリプト
    // （nonce を持つ）は外の世界で動かす
    if let Some(sites) = passkey_sites.filter(|_| !data.incognito()) {
        out.push(PageScript {
            all_frames: true,
            isolated: false,
            source: passkey::page_script(sites),
        });
        out.push(PageScript {
            all_frames: true,
            isolated: true,
            source: passkey::tell_script(nonce, sites),
        });
    }
    // macOS：ページの window.close を差し替えるスクリプトはページの世界で、殻に知らせるスクリプト（nonce を持つ）は外の世界で動かす
    #[cfg(target_os = "macos")]
    {
        out.push(PageScript {
            all_frames: false,
            isolated: false,
            source: CLOSE_SCRIPT.to_string(),
        });
        out.push(PageScript {
            all_frames: false,
            isolated: true,
            source: close_tell_script(nonce),
        });
    }
    out
}

/// ページの外の世界で動かすスクリプトを、タブの webview に足す。webview を作ったのと同じメインスレッドの処理の中で呼ぶ
/// （wry はページの世界にしか入れられないので、作った後で OS の WebView に直接足す。同じ処理の中で足せば、最初のページの
/// 読み込みが進む前に WebView に伝わる。メインスレッドの外から呼ぶと、足す前に最初のページが出て、そのページでは
/// キーが効かないことがある）。足せなければ、そのタブでは、ページにキーがある間のリーダーと近道・パスキー・macOS の
/// `window.close` が効かない（nonce をページの世界に置くより、効かない方を選ぶ）。
fn add_world_scripts(v: &Webview, scripts: Vec<PageScript>) {
    if scripts.is_empty() {
        return;
    }
    let r = v.with_webview(move |pv| {
        if !add_to_world(&pv, &scripts) {
            eprintln!(
                "kisui-terminal: cannot add the page scripts to an isolated world; keys do not work while the page has focus"
            );
        }
    });
    if let Err(e) = r {
        eprintln!("kisui-terminal: cannot add the page scripts: {e}");
    }
}

/// Linux：WebKitGTK の world に、文書の始まりで動くスクリプトとして足す。
#[cfg(target_os = "linux")]
fn add_to_world(pv: &tauri::webview::PlatformWebview, scripts: &[PageScript]) -> bool {
    use webkit2gtk::{
        UserContentInjectedFrames, UserContentManagerExt, UserScript, UserScriptInjectionTime,
        WebViewExt,
    };
    let Some(m) = pv.inner().user_content_manager() else {
        return false;
    };
    for s in scripts {
        let frames = if s.all_frames {
            UserContentInjectedFrames::AllFrames
        } else {
            UserContentInjectedFrames::TopFrame
        };
        m.add_script(&UserScript::for_world(
            &s.source,
            frames,
            UserScriptInjectionTime::Start,
            WORLD,
            &[],
            &[],
        ));
    }
    true
}

/// macOS：WKContentWorld に、文書の始まりで動くスクリプトとして足す（macOS 11 から。それより前は足せない）。
#[cfg(target_os = "macos")]
fn add_to_world(pv: &tauri::webview::PlatformWebview, scripts: &[PageScript]) -> bool {
    use objc2::MainThreadOnly;
    use objc2_foundation::NSString;
    use objc2_web_kit::{WKContentWorld, WKUserScript, WKUserScriptInjectionTime};

    if objc2::runtime::AnyClass::get(c"WKContentWorld").is_none() {
        return false;
    }
    let Some((w, mtm)) = wk_webview(pv) else {
        return false;
    };
    // SAFETY: メインスレッドで呼ぶ（mtm）。w は、with_webview の閉包の間は生きている WKWebView。
    // configuration は設定の写しを返すが、スクリプトの入れ物（userContentController）は webview が使っているものと同じ
    unsafe {
        let world = WKContentWorld::worldWithName(&NSString::from_str(WORLD), mtm);
        let controller = w.configuration().userContentController();
        for s in scripts {
            let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly_inContentWorld(
                WKUserScript::alloc(mtm),
                &NSString::from_str(&s.source),
                WKUserScriptInjectionTime::AtDocumentStart,
                !s.all_frames,
                &world,
            );
            controller.addUserScript(&script);
        }
    }
    true
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn add_to_world(_: &tauri::webview::PlatformWebview, _: &[PageScript]) -> bool {
    false
}

/// メインスレッドで f を動かし、答えを待つ。
fn on_main_thread<R: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce() -> R + Send + 'static,
) -> Result<R, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}

/// 遷移・新しい窓・読み込み・題の変化・ダウンロード（macOS）の受け口を足す。
fn with_handlers(
    builder: WebviewBuilder<tauri::Wry>,
    app: &AppHandle,
    tab: &str,
    nonce: String,
) -> WebviewBuilder<tauri::Wry> {
    let (win_app, win_tab) = (app.clone(), tab.to_string());
    let (nav_app, nav_tab) = (app.clone(), tab.to_string());
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
        .on_navigation(move |u| {
            let ok = may_navigate(u);
            if ok {
                // 遷移が始まった。読み込み中かと進み具合を見始める（browser_progress.rs）
                crate::browser_progress::watch(&nav_app, &nav_tab);
            }
            ok
        })
        .on_new_window(move |u, f| on_new_window(&win_app, &win_tab, &nonce, u, f))
        .on_page_load(move |w, p| {
            let loading = match p.event() {
                PageLoadEvent::Started => true,
                PageLoadEvent::Finished => false,
            };
            if loading {
                crate::browser_progress::watch(&load_app, &load_tab);
                // ページが替わった。前の読み込みの失敗は、もう無い（画面に片付けさせる。browser_load.rs）
                crate::browser_load::clear_failure(&load_app, &load_tab);
                page.started();
            } else {
                page.finished();
            }
            // 戻る先・進む先の有無を見始める（#450。browser_progress.rs。タブごとに 1 本）
            crate::browser_progress::watch_history(&load_app, &load_tab);
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
        #[cfg(target_os = "macos")]
        Data::ProxiedIncognito(c) => builder.with_webview_configuration(c.0),
        #[cfg(target_os = "linux")]
        Data::Captured(proxy) => crate::browser_capture::with_proxy(builder, proxy),
        #[cfg(target_os = "macos")]
        Data::Captured(c) => builder.with_webview_configuration(c.0),
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
/// ページの外の世界で動かすスクリプトは、ここでは入れられないので返す。webview を作ったら、同じメインスレッドの処理の中で
/// `add_world_scripts` に渡す。
fn tab_builder(
    app: &AppHandle,
    tab: &str,
    first: Url,
    nonce: String,
    keys: &[KeySpec],
    data: Data,
) -> (WebviewBuilder<tauri::Wry>, Vec<PageScript>) {
    // DevTools（ブラウザのタブの窓の `i`。#205）はタブのページで使う（メインの webview は、release では main.rs で切る）
    let mut builder = WebviewBuilder::new(label(tab), WebviewUrl::External(first))
        .focused(false)
        .devtools(true);
    let passkey = app.try_state::<Arc<Passkey>>();
    let sites = passkey.as_deref().map(|p| p.sites());
    let (world, page): (Vec<_>, Vec<_>) = page_scripts(&nonce, keys, sites, &data)
        .into_iter()
        .partition(|s| s.isolated);
    for s in page {
        builder = if s.all_frames {
            builder.initialization_script_for_all_frames(s.source)
        } else {
            builder.initialization_script(s.source)
        };
    }
    let builder = with_handlers(builder, app, tab, nonce);
    (with_data(builder, app, data), world)
}

/// タブを作る（子の webview）。`x`・`y`・`w`・`h` は画面が測ったページの四角、`vw`・`vh` はそのときの viewport の大きさ
/// （論理ピクセル。browser_frame.rs の `Placement`）。作るだけで、キーは向けない（`browser_focus`）。
/// `keys` はページにキーがある間も受けるキー（リーダーと近道）。`incognito` はシークレットのタブ（#204）。
/// macOS では、初めてのタブの前に内蔵ブラウザのプロキシを用意する（browser_proxy.rs。#294。証明書の信頼を聞くことがあり、
/// 答えを待つ）。
/// `proxy` があれば、通信を記録するプロキシ（127.0.0.1 のそのポート。#409）に通すタブにする（browser_capture.rs）。
/// そのタブだけの、ディスクに残さないデータを使う。通せなければ（macOS 13 以前など）、作らずに理由を返す。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser_open(
    app: AppHandle,
    webview: Webview,
    tabs: State<'_, Tabs>,
    tab: String,
    url: String,
    keys: Vec<KeySpec>,
    incognito: bool,
    proxy: Option<u16>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    vw: f64,
    vh: f64,
) -> Result<(), String> {
    from_main(&webview)?;
    if !valid_tab(&tab) {
        return Err("invalid tab id".into());
    }
    if !valid_keys(&keys) {
        return Err("invalid keys".into());
    }
    let at = Placement::new(x, y, w, h, vw, vh)?;
    let first = parse_url(&url)?;
    // macOS：通していたタブを、通さずに作り直す（通すのをやめた・kisui serve が止まった）なら、そのタブを元にした
    // データストアを忘れる（browser_capture.rs）。閉じたときに忘れるのは下のタブが全部閉じたときだけなので、そこから
    // 開いた新しい窓のタブが残っていると、通しているタブがあることになったまま残る
    #[cfg(target_os = "macos")]
    if proxy.is_none() {
        crate::browser_capture::forget(&app, &tab);
    }
    // macOS：読み込みの失敗の受け口を、タブの webview を作る前に足す（WebKit は、delegate を付けたときに受け口を調べて覚える。
    // browser_load.rs。#432）
    #[cfg(target_os = "macos")]
    crate::browser_load::install(&app).await;
    let data = match proxy {
        Some(port) => captured_data(&app, &tab, port).await?,
        None => tab_data(&app, incognito).await,
    };
    // Linux の通すタブは、証明書の扱いを決めてから読み込む（browser_capture.rs の trust_and_load）。それまでは空のページ
    #[cfg(target_os = "linux")]
    let (first, load_later) = match proxy {
        Some(_) => (
            Url::parse("about:blank").map_err(|e| e.to_string())?,
            Some(first),
        ),
        None => (first, None),
    };
    let win = app
        .get_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    if app.get_webview(&label(&tab)).is_some() {
        return Err("the tab is already open".into());
    }
    let nonce = new_nonce()?;
    let (builder, world_scripts) = tab_builder(&app, &tab, first, nonce.clone(), &keys, data);
    // webview を作るのと、ページの外の世界のスクリプトを足すのを、メインスレッドの 1 つの処理で行う（`add_world_scripts`）
    let (pos, size) = (
        LogicalPosition::new(at.x, at.y),
        LogicalSize::new(at.w, at.h),
    );
    let v = on_main_thread(&app, move || {
        let v = win
            .add_child(builder, pos, size)
            .map_err(|e| e.to_string())?;
        add_world_scripts(&v, world_scripts);
        Ok::<_, String>(v)
    })??;
    // 作るときの場所は wry の数え方で仮に置かれるので、すぐに置き直す（macOS。browser_frame.rs）。置き直せなくても、
    // タブは作れているので続ける（画面は、場所が変わったら browser_bounds で置き直す）
    if let Err(e) = crate::browser_frame::place(&app, &v, &tab, at) {
        eprintln!("kisui-terminal: cannot place the page: {e}");
    }
    tabs.set(
        &tab,
        TabInfo {
            keys,
            incognito,
            nonce,
            root: tab.clone(),
            proxied: proxy.is_some(),
        },
    );
    watch_native(&app, &v, &tab, proxy.is_some());
    #[cfg(target_os = "linux")]
    if let Some(url) = load_later {
        crate::browser_capture::trust_and_load(&v, url)?;
    }
    Ok(())
}

/// 通信を記録するプロキシ（127.0.0.1 の port。#409）に通すタブのデータの置き場。
#[cfg(target_os = "linux")]
async fn captured_data(_: &AppHandle, _: &str, port: u16) -> Result<Data, String> {
    Ok(Data::Captured(crate::browser_capture::proxy_url(port)?))
}

#[cfg(target_os = "macos")]
async fn captured_data(app: &AppHandle, tab: &str, port: u16) -> Result<Data, String> {
    crate::browser_capture::proxy_url(port)?;
    Ok(Data::Captured(
        crate::browser_capture::configuration(app, tab.to_string(), port).await?,
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
async fn captured_data(_: &AppHandle, _: &str, _: u16) -> Result<Data, String> {
    Err("the proxy is not supported on this OS".into())
}

/// 新しいタブ（ページが開いた新しい窓でないもの）のデータの置き場。
/// macOS では、内蔵ブラウザのプロキシを用意する（共有のデータストアには、用意したときに当ててある）。
/// シークレットのタブは、プロキシを当てたディスクに残さないデータストアを作る。プロキシが使えなければ、今までどおり。
#[cfg(target_os = "macos")]
async fn tab_data(app: &AppHandle, incognito: bool) -> Data {
    let ports = crate::browser_proxy::ready(app).await;
    if !incognito {
        return Data::Shared;
    }
    if let Some(p) = ports {
        match crate::browser_proxy::private_configuration(app, p).await {
            Some(c) => return Data::ProxiedIncognito(c),
            None => eprintln!(
                "kisui-terminal: cannot set the proxy on a private tab; it goes without the proxy"
            ),
        }
    }
    Data::Incognito
}

#[cfg(not(target_os = "macos"))]
async fn tab_data(_: &AppHandle, incognito: bool) -> Data {
    if incognito {
        Data::Incognito
    } else {
        Data::Shared
    }
}

/// タブの位置と大きさを合わせる。`x`・`y`・`w`・`h` は画面が測ったページの四角、`vw`・`vh` はそのときの viewport の
/// 大きさ（論理ピクセル。browser_frame.rs の `Placement`）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn browser_bounds(
    app: AppHandle,
    webview: Webview,
    tab: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    vw: f64,
    vh: f64,
) -> Result<(), String> {
    from_main(&webview)?;
    let at = Placement::new(x, y, w, h, vw, vh)?;
    let v = child(&app, &tab)?;
    crate::browser_frame::place(&app, &v, &tab, at)
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

/// 重なりもの（お知らせ・リーダーの案内・キャラクター・メニュー）を、ページを縮めずにページの上に重ねられるか（macOS だけ）。
/// 重ねられるなら、メインの webview の背景を透明にして true を返す（画面は、ページの場所の背景を塗らないようにする）。
/// 重ね方は `browser_layer`。macOS 以外は何もせず false（画面は、これまでどおりページを縮めて避ける）。
#[tauri::command]
pub fn browser_overlay_enable(app: AppHandle, webview: Webview) -> Result<bool, String> {
    from_main(&webview)?;
    #[cfg(target_os = "macos")]
    {
        let m = app
            .get_webview("main")
            .ok_or_else(|| "no main webview".to_string())?;
        m.set_background_color(Some(tauri::webview::Color(0, 0, 0, 0)))
            .map_err(|e| e.to_string())?;
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(false)
    }
}

/// 前に出すものを決める（macOS だけ。`browser_overlay_enable` が true のとき）。
/// overlay なら、メインの webview（画面）をページより前に出し、キーも画面に向ける（ページは操作できなくなる。動き続ける）。
/// そうでなければ、タブのページを前に出す（キーを向け直すのは画面）。
/// 前に出すのは、同じ窓への `reparent`（macOS の wry では `addSubview` し直しで、兄弟の view のいちばん前に移る）。
#[tauri::command]
pub fn browser_layer(
    app: AppHandle,
    webview: Webview,
    tab: String,
    overlay: bool,
) -> Result<(), String> {
    from_main(&webview)?;
    #[cfg(target_os = "macos")]
    {
        let win = app
            .get_window("main")
            .ok_or_else(|| "no main window".to_string())?;
        if overlay {
            let m = app
                .get_webview("main")
                .ok_or_else(|| "no main webview".to_string())?;
            m.reparent(&win).map_err(|e| e.to_string())?;
            let _ = m.set_focus();
        } else {
            child(&app, &tab)?
                .reparent(&win)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, tab, overlay);
        Ok(())
    }
}

/// タブのページにキーを向ける。
#[tauri::command]
pub fn browser_focus(app: AppHandle, webview: Webview, tab: String) -> Result<(), String> {
    from_main(&webview)?;
    child(&app, &tab)?.set_focus().map_err(|e| e.to_string())
}

/// タブで URL を開く（URL バー。ブラウザのタブの窓の `u` でキーが向く）。
#[tauri::command]
pub fn browser_go(
    app: AppHandle,
    webview: Webview,
    tab: String,
    url: String,
) -> Result<(), String> {
    from_main(&webview)?;
    let v = child(&app, &tab)?;
    let u = parse_url(&url)?;
    // 次の読み込みを頼んだので、前の失敗の表示は片付ける（また失敗すれば出直す。browser_load.rs）
    crate::browser_load::clear_failure(&app, &tab);
    crate::browser_progress::watch(&app, &tab);
    v.navigate(u).map_err(|e| e.to_string())
}

/// 読み込みを止める（URL バーの「×」・読み込み中の Esc・ブラウザのタブの窓の `c`）。ページは前のまま残る。
#[tauri::command]
pub fn browser_stop(app: AppHandle, webview: Webview, tab: String) -> Result<(), String> {
    from_main(&webview)?;
    crate::browser_progress::stop(&child(&app, &tab)?)
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
        // 戻る・進むは、頼んだ時点では失敗の表示を片付けない。行き先の履歴が無ければ何も起きず、片付けると、
        // 開けなかった URL が URL バーに残ったまま、失敗の前のページが出てしまう。履歴があれば別の項目に移るので、
        // ページが替わった知らせ（browser-page の loading）で片付く
        "back" => v.eval("history.back()"),
        "forward" => v.eval("history.forward()"),
        // 読み込みが失敗したままのタブの「読み込み直す」は、画面が開けなかった URL を browser_go で開き直す
        // （WebView の読み込み直しは、失敗の前のページを読み直す。app/src/features/browser/pages.ts の navPage）
        "reload" => {
            // 次の読み込みを頼んだので、前の失敗の表示は片付ける（また失敗すれば出直す。browser_load.rs）
            crate::browser_load::clear_failure(&app, &tab);
            crate::browser_progress::watch(&app, &tab);
            v.reload()
        }
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
    // macOS：通していたタブ（browser_capture.rs）の下のタブが全部閉じたら、そのデータストアを忘れる
    #[cfg(target_os = "macos")]
    if let Some(root) = tabs.last_of_root(&tab) {
        crate::browser_capture::forget(&app, &root);
    }
    tabs.remove(&tab);
    // macOS の、読み込みの失敗の知らせの先を忘れる（browser_load.rs）
    #[cfg(target_os = "macos")]
    crate::browser_load::unregister(&app, &tab);
    crate::browser_frame::forget(&app, &tab);
    if let Some(v) = app.get_webview(&label(&tab)) {
        let _ = v.close();
        focus_main(&app);
    }
    Ok(())
}

/// ページの表示の大きさの範囲（倍率。#205）。画面が選ぶ段（app/src/features/scale/scale.ts の SCALES）より広く受ける。
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

/// ページ内を探す（#205。ブラウザのタブの窓の `/`・Cmd+F / Ctrl+F）。mode は `first`（探す字を変えた）・`next`・`prev`。見つかったかを返す。
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

/// パスキーを待たずに、今のタブのサイトを外のブラウザで開き、そのサイトのログインを待つ（#276。ブラウザのタブの窓の `s`）。
/// 答えは `opened`（開いた。同じタブから続けて押したときは開き直さない）・`no-sites`（`passkey_sites` が無い）・
/// `incognito`（シークレットのタブ）・`not-allowed`（今のページが許可サイトのものでない）。決めるのは passkey.rs の `start`。
#[tauri::command]
pub fn browser_passkey_login(
    app: AppHandle,
    webview: Webview,
    tabs: State<Tabs>,
    tab: String,
) -> Result<String, String> {
    from_main(&webview)?;
    let v = child(&app, &tab)?;
    let info = tabs
        .get(&tab)
        .ok_or_else(|| "no such browser tab".to_string())?;
    // 外のブラウザで開く URL は、画面から受け取らず、タブの今の URL（一番上のフレーム）を読む
    let page_url = v.url().map_err(|e| e.to_string())?;
    let p = app.try_state::<Arc<Passkey>>();
    let p = p.as_deref().map(Arc::as_ref);
    let r = passkey::start(p, info.incognito, &tab, &page_url, Instant::now());
    if let passkey::Start::Opened(Some(to)) = &r {
        passkey::open_external(to);
    }
    Ok(r.code().to_string())
}

/// タブのページの DevTools（Web Inspector）を開く（#205。ブラウザのタブの窓の `i`）。
/// Linux（WebKitGTK）は、ページの webview の中にくっつく（ページの領域の外には出ない）。macOS は別の窓で開く（`open_devtools`）。
#[tauri::command]
pub fn browser_devtools(app: AppHandle, webview: Webview, tab: String) -> Result<(), String> {
    from_main(&webview)?;
    open_devtools(&child(&app, &tab)?);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn open_devtools(v: &Webview) {
    v.open_devtools();
}

/// macOS：`with_webview` の閉包に渡る webview から、ページの WKWebView と、メインスレッドの印を取り出す。
/// 閉包の外（メインスレッドでない所）や、WKWebView が無いときは None。返す WKWebView は `pv` が生きている間だけ使う。
#[cfg(target_os = "macos")]
pub(crate) fn wk_webview(
    pv: &tauri::webview::PlatformWebview,
) -> Option<(&objc2_web_kit::WKWebView, objc2::MainThreadMarker)> {
    // with_webview の中はメインスレッド
    let mtm = objc2::MainThreadMarker::new()?;
    let ptr = pv.inner() as *const objc2_web_kit::WKWebView;
    if ptr.is_null() {
        return None;
    }
    // SAFETY: tauri の PlatformWebview::inner は、生きている WKWebView を指す（with_webview の閉包の間。返す参照の
    // 寿命は pv に縛る）
    Some((unsafe { &*ptr }, mtm))
}

/// macOS：DevTools を別の窓で開き、窓にくっつけさせない。
///
/// WKWebView の Web Inspector は、くっつける先の view（`_inspectorAttachmentView`。既定はページの WKWebView 自身）の
/// 「親の view」の大きさを基準に、くっつける先の枠を組み替える（WebKit の WebInspectorUIProxyMac.mm の
/// `inspectedViewFrameDidChange`。下にくっつけるときは、横は親の幅いっぱい、縦は親の下から Inspector の高さを除いた所）。
/// タブのページの WKWebView は、kisui-terminal の画面（メインの webview）と同じく窓の content view の子なので（wry の子の
/// webview）、ページの枠が窓の幅いっぱいに広がってサイドバーにかぶさり、Inspector は窓の下に置かれる。
/// そこで、くっつける先を、窓に置かない隠した view に替える。隠した view にはくっつけられない（`platformCanAttach` が断る）
/// ので、Inspector は必ず別の窓で開き、Inspector の「くっつける」ボタンでもくっつかない。ページの枠には触らない。
#[cfg(target_os = "macos")]
fn open_devtools(v: &Webview) {
    let r = v.with_webview(|pv| {
        use objc2::rc::Retained;
        use objc2::runtime::{AnyObject, NSObjectProtocol};
        use objc2::{msg_send, sel};
        use objc2_app_kit::NSView;

        thread_local! {
            /// くっつける先にする、窓に置かない隠した view（すべてのタブで 1 つ。アプリが終わるまで持つ）
            static NOWHERE: std::cell::OnceCell<Retained<NSView>> = const { std::cell::OnceCell::new() };
        }

        let Some((w, mtm)) = wk_webview(&pv) else {
            return;
        };
        // `_setInspectorAttachmentView:` は Apple の非公開の API（macOS 10.13.4 から）。無ければ替えずに開く
        if w.respondsToSelector(sel!(_setInspectorAttachmentView:)) {
            NOWHERE.with(|n| {
                let nowhere = n.get_or_init(|| {
                    let view = NSView::new(mtm);
                    view.setHidden(true);
                    view
                });
                // SAFETY: WKWebView の非公開の setter。引数は生きている NSView（こちらもアプリが終わるまで持つ）
                let () = unsafe { msg_send![w, _setInspectorAttachmentView: &**nowhere] };
            });
        }
        // wry の open_devtools と同じ（`_inspector` の `show`）。くっつける先を替えてから開くよう、同じ閉包で呼ぶ
        // SAFETY: `_inspector` は _WKInspector を返す非公開の API（wry も同じものを使う）
        let inspector: Option<Retained<AnyObject>> = unsafe { msg_send![w, _inspector] };
        if let Some(i) = inspector {
            let () = unsafe { msg_send![&i, show] };
        }
    });
    if let Err(e) = r {
        eprintln!("kisui-terminal: cannot open DevTools: {e}");
    }
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

    // キーの中身は、先に取っておいた getter だけで読む。受けたイベント（ev）から直接読むのは、差し替えられない isTrusted だけ
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

    // ページの Esc の知らせ（#449）は、nonce が合うものだけ受ける。キーの知らせ（host が key）とは別
    #[test]
    fn escape_notices_need_the_nonce() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(is_escape_notice(&u("kisui-key://esc?n=abc"), "abc"));
        assert!(!is_escape_notice(&u("kisui-key://esc?n=abd"), "abc"));
        assert!(!is_escape_notice(&u("kisui-key://esc"), "abc"));
        assert!(!is_escape_notice(&u("kisui-key://esc?n="), ""));
        assert!(!is_escape_notice(
            &u("kisui-key://key?n=abc&k=a&m=0"),
            "abc"
        ));
        assert!(!is_escape_notice(&u("https://esc/?n=abc"), "abc"));
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

    // 閉じた知らせのスクリプト（ページの外の世界で動かす）は、殻の受ける URL の形で知らせ、nonce を埋めて使う
    #[test]
    fn close_script_sends_the_url_this_shell_reads() {
        assert!(CLOSE_TELL_SCRIPT.contains("\"kisui-close://close?n=\""));
        assert!(!CLOSE_TELL_SCRIPT.contains("location"));
        let s = close_tell_script("abc\"</script>");
        assert!(!s.contains("__KISUI_"), "{s}");
        assert!(s.contains(r#"const nonce = "abc\"</script>";"#), "{s}");
        // ページの世界で動かすスクリプト（window.close を差し替える）は、nonce を持たず、殻にも直接は知らせない。
        // 外の世界のスクリプトが受けるのと同じ名前のイベントで知らせる
        let page = include_str!("browser_close.js");
        assert!(!page.contains("__KISUI_NONCE__"));
        assert!(!page.contains("kisui-close://"));
        assert!(!page.contains("window.open"));
        assert!(page.contains(r#"new Ev("kisui-close")"#));
        assert!(CLOSE_TELL_SCRIPT.contains(r#""kisui-close","#));
    }

    fn spec(ctrl: bool, shift: bool, alt: bool, meta: bool, key: &str, enter: bool) -> KeySpec {
        KeySpec {
            ctrl,
            shift,
            alt,
            meta,
            key: key.into(),
            enter,
        }
    }

    /// ページのスクリプトが知らせるキー（mods は URL の m と同じ。1 が Ctrl、2 が Shift、4 が Alt、8 が Meta）。
    fn pressed(key: &str, code: &str, mods: u8) -> KeyEvent {
        KeyEvent {
            tab: "t1".into(),
            key: key.into(),
            code: code.into(),
            ctrl_key: mods & 1 != 0,
            shift_key: mods & 2 != 0,
            alt_key: mods & 4 != 0,
            meta_key: mods & 8 != 0,
            repeat: false,
        }
    }

    // nonce を持つスクリプトは、ページの外の世界で動かす。ページの世界で動かすスクリプトには、nonce を入れない
    // （ページのスクリプトは、ページの世界で動くスクリプトに渡した値を読める）
    #[test]
    fn scripts_with_the_nonce_run_outside_the_page_world() {
        let nonce = "0123456789abcdef0123456789abcdef";
        let keys = vec![spec(true, true, false, false, "k", true)];
        let sites = vec!["github.com".to_string()];
        for data in [Data::Shared, Data::Incognito] {
            let scripts = page_scripts(nonce, &keys, Some(&sites), &data);
            assert!(scripts.iter().any(|s| s.isolated));
            for s in &scripts {
                assert_eq!(s.source.contains(nonce), s.isolated, "{}", s.source);
                assert!(!s.source.contains("__KISUI_"), "{}", s.source);
            }
            // パスキーのスクリプトは、シークレットのタブには入れない
            let passkey = scripts
                .iter()
                .filter(|s| s.source.contains("kisui-passkey"))
                .count();
            assert_eq!(passkey, if data.incognito() { 0 } else { 2 });
        }
        // パスキーのサイトが無ければ、パスキーのスクリプトは入れない
        let scripts = page_scripts(nonce, &keys, None, &Data::Shared);
        assert!(!scripts.iter().any(|s| s.source.contains("kisui-passkey")));
    }

    // 殻の照らし方は、ページのスクリプト（browser_keys.js の match）・画面（keyspec.ts の matchSpec）と同じ
    #[test]
    fn keys_match_like_the_page_script() {
        let leader = spec(true, true, false, false, "k", true);
        // Shift を押すと key は大文字になる。かな入力などで key が別の字でも、code で当たる
        assert!(key_matches(&pressed("K", "KeyK", 3), &leader));
        assert!(key_matches(&pressed("の", "KeyK", 3), &leader));
        assert!(!key_matches(&pressed("K", "KeyK", 2), &leader));
        assert!(!key_matches(&pressed("K", "KeyK", 11), &leader));
        assert!(!key_matches(&pressed("J", "KeyJ", 3), &leader));
        // `+` と `=` は Shift を見ない。ほかは見る
        let plus = spec(true, false, false, false, "+", false);
        assert!(key_matches(&pressed("=", "Equal", 1), &plus));
        assert!(key_matches(&pressed("+", "Equal", 3), &plus));
        assert!(key_matches(&pressed("+", "NumpadAdd", 1), &plus));
        let zero = spec(true, false, false, false, "0", false);
        assert!(key_matches(&pressed("0", "Digit0", 1), &zero));
        assert!(key_matches(&pressed("0", "Numpad0", 1), &zero));
        assert!(!key_matches(&pressed(")", "Digit0", 3), &zero));
        let minus = spec(false, false, false, true, "-", false);
        assert!(key_matches(&pressed("-", "Minus", 8), &minus));
        assert!(key_matches(&pressed("-", "NumpadSubtract", 8), &minus));
        // 名前のあるキーは key で照らす
        let enter = spec(false, true, false, true, "Enter", false);
        assert!(key_matches(&pressed("Enter", "Enter", 10), &enter));
        assert!(!key_matches(&pressed("Enter", "Enter", 8), &enter));
        let space = spec(true, false, false, false, "Space", false);
        assert!(key_matches(&pressed(" ", "Space", 1), &space));
        let up = spec(false, false, true, false, "ArrowUp", false);
        assert!(key_matches(&pressed("ArrowUp", "ArrowUp", 4), &up));
        assert!(!key_matches(&pressed("ArrowDown", "ArrowDown", 4), &up));
    }

    // nonce が合っても、登録していないキーは受けない（画面に渡さない）。リーダーに入るキーのあとの短い間だけ、続きのキーを受ける
    #[test]
    fn unregistered_keys_are_not_accepted() {
        let keys = vec![
            spec(true, true, false, false, "k", true),
            spec(true, false, false, false, "r", false),
        ];
        let t0 = Instant::now();
        let mut until = None;
        // 登録していないキー（文字・Enter・修飾キー付きのキー）
        for ev in [
            pressed("a", "KeyA", 0),
            pressed("Enter", "Enter", 0),
            pressed("y", "KeyY", 0),
            pressed("w", "KeyW", 1),
            pressed("k", "KeyK", 1),
            pressed("K", "KeyK", 2),
            pressed("Escape", "Escape", 0),
        ] {
            assert!(!accept_key(&keys, &mut until, &ev, t0), "{ev:?}");
            assert_eq!(until, None);
        }
        // 近道は受けるが、そのあとの登録していないキーは受けない
        assert!(accept_key(&keys, &mut until, &pressed("r", "KeyR", 1), t0));
        assert_eq!(until, None);
        assert!(!accept_key(&keys, &mut until, &pressed("i", "KeyI", 0), t0));
        // リーダーに入るキーのあとは、続きのキーを受ける（修飾キーだけのキーは受けない）
        assert!(accept_key(&keys, &mut until, &pressed("K", "KeyK", 3), t0));
        assert!(!accept_key(
            &keys,
            &mut until,
            &pressed("Shift", "ShiftLeft", 2),
            t0
        ));
        let t1 = t0 + FOLLOW / 2;
        assert!(accept_key(&keys, &mut until, &pressed("i", "KeyI", 0), t1));
        // 続きのキーのたびに延びる
        let t2 = t1 + FOLLOW;
        assert!(accept_key(&keys, &mut until, &pressed("o", "KeyO", 0), t2));
        // 期限を過ぎたら、また受けない
        let t3 = t2 + FOLLOW + Duration::from_millis(1);
        assert!(!accept_key(&keys, &mut until, &pressed("o", "KeyO", 0), t3));
        assert_eq!(until, None);
    }

    // 続きのキーを受ける期限はタブごと。知らないタブ・閉じたタブのキーは受けない
    #[test]
    fn keys_are_checked_against_the_keys_of_the_tab() {
        let tabs = Tabs::default();
        let info = |keys: Vec<KeySpec>| TabInfo {
            keys,
            incognito: false,
            nonce: "abc".into(),
            root: "t1".into(),
            proxied: false,
        };
        tabs.set("t1", info(vec![spec(true, true, false, false, "k", true)]));
        tabs.set(
            "t2",
            info(vec![spec(true, false, false, false, "r", false)]),
        );
        let t0 = Instant::now();
        let leader = pressed("K", "KeyK", 3);
        let plain = pressed("i", "KeyI", 0);
        assert!(!tabs.accept_key("t1", &plain, t0));
        assert!(!tabs.accept_key("nope", &leader, t0));
        // t2 はリーダーのキーを登録していない
        assert!(!tabs.accept_key("t2", &leader, t0));
        assert!(tabs.accept_key("t1", &leader, t0));
        // t1 がリーダーに入っても、t2 の続きのキーは受けない
        assert!(!tabs.accept_key("t2", &plain, t0));
        assert!(tabs.accept_key("t1", &plain, t0));
        // 閉じたタブは、同じ id で作り直しても、前の期限を引き継がない
        tabs.remove("t1");
        assert!(!tabs.accept_key("t1", &plain, t0));
        tabs.set("t1", info(vec![spec(true, true, false, false, "k", true)]));
        assert!(!tabs.accept_key("t1", &plain, t0));
    }
}
