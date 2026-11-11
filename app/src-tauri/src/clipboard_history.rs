//! クリップボードの履歴（#53）。
//!
//! 手元の OS のクリップボードを一定の間隔で調べ、文字が変わったら履歴に入れる。kisui の中のコピー
//! （`kisui clipboard copy` の OSC 5522・shj のコピー）も、kisui-terminal の外のコピーも、OS のクリップボードを通るので
//! すべて入る。
//!
//! - 入れるのは文字だけ（画像は入れない）。空の文字と、`MAX_TEXT_BYTES` を超える文字も入れない。
//! - 起動したときにクリップボードにある文字は、比べる元にするだけで入れない（起動したときの中身は「変化」ではない）。
//! - 同じ文字がもう履歴にあれば、新しく足さずに先頭へ動かす（時刻も新しくする）。先頭と同じなら何もしない。
//! - 入れてから `MAX_AGE` たったものと、`MAX_ENTRIES` 件を超えた古いものは消す。
//! - パスワード管理アプリが「秘密」の印を付けたコピーは入れない。macOS は `org.nspasteboard.ConcealedType` と
//!   `org.nspasteboard.TransientType`、Linux は `x-kde-passwordManagerHint`。印があるかを確かめられないときも入れない。
//! - 履歴はアプリのデータのディレクトリの `clipboard-history.json` に残す（権限 0600）。
//!
//! 画面には、変わったことを `clipboard-history-changed`（中身なし）で知らせ、中身は `clipboard_history_list` で渡す。
//! 中身をイベントに載せないのは、ブラウザの欄（外のページの子の webview）に届かないようにするため。命令は
//! 呼んだ webview が `main` か、kisui-terminal の外から開く履歴の窓（clipboard_popup.rs）かも確かめる。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, Webview};

/// 残す件数の上限。
pub const MAX_ENTRIES: usize = 20;
/// 残す時間（入れてから 12 時間）。
pub const MAX_AGE: Duration = Duration::from_secs(12 * 60 * 60);
/// 1 件の文字の上限（これより大きいコピーは入れない。ファイルを毎回書き直すので、大きくしない）。
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
/// 保存するファイルの名前（アプリのデータのディレクトリの中）。
const FILE_NAME: &str = "clipboard-history.json";
/// 保存するファイルの形式の版。
const FORMAT_VERSION: u32 = 1;
/// 画面に変わったことを知らせるイベント。
const EVENT_CHANGED: &str = "clipboard-history-changed";

/// 履歴の 1 件。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// コピーされた文字
    pub text: String,
    /// 入れた時刻（UNIX 時刻のミリ秒）
    pub copied_at: u64,
}

/// 履歴。新しいものが先頭。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct History {
    entries: Vec<Entry>,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    version: u32,
    entries: Vec<Entry>,
}

impl History {
    /// 履歴（新しいものが先頭）。
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// `text` を `now`（UNIX 時刻のミリ秒）に入れる。履歴が変わったら true。
    pub fn add(&mut self, text: &str, now: u64) -> bool {
        if text.is_empty() || text.len() > MAX_TEXT_BYTES {
            return false;
        }
        if self.entries.first().is_some_and(|e| e.text == text) {
            return false;
        }
        self.entries.retain(|e| e.text != text);
        self.entries.insert(
            0,
            Entry {
                text: text.to_owned(),
                copied_at: now,
            },
        );
        self.entries.truncate(MAX_ENTRIES);
        true
    }

    /// 入れてから `MAX_AGE` たったものと、`MAX_ENTRIES` 件を超えた古いものを消す。変えたら true。
    ///
    /// 時刻が `now` より先のもの（時計が進みすぎていたときに入れた、ファイルを手で書き換えたなど）は、`now` に
    /// 丸める。そのままだと、時計が追いつくまで消えないため。
    pub fn prune(&mut self, now: u64) -> bool {
        let mut clamped = false;
        for e in &mut self.entries {
            if e.copied_at > now {
                e.copied_at = now;
                clamped = true;
            }
        }
        let before = self.entries.len();
        let max_age = MAX_AGE.as_millis() as u64;
        self.entries
            .retain(|e| now.saturating_sub(e.copied_at) < max_age);
        self.entries.truncate(MAX_ENTRIES);
        clamped || self.entries.len() != before
    }

    /// ファイルから読む。無い・壊れている・版が違うときは空。古いものは消してから返す。
    pub fn load(path: &Path, now: u64) -> History {
        let stored = fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Stored>(&b).ok())
            .filter(|s| s.version == FORMAT_VERSION);
        let mut h = History {
            entries: stored.map(|s| s.entries).unwrap_or_default(),
        };
        // 新しいものが先頭になるように並べ直す（手で書き換えられたときのため）
        h.entries.sort_by(|a, b| b.copied_at.cmp(&a.copied_at));
        h.entries
            .retain(|e| !e.text.is_empty() && e.text.len() <= MAX_TEXT_BYTES);
        h.prune(now);
        h
    }

    /// ファイルに書く。ユーザーだけが読み書きできる一時ファイルに書いてから、置き換える。
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            create_private_dir(dir)?;
        }
        let body = serde_json::to_vec(&Stored {
            version: FORMAT_VERSION,
            entries: self.entries.clone(),
        })
        .map_err(std::io::Error::other)?;
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        let _ = fs::remove_file(&tmp);
        let mut f = open_private(&tmp)?;
        f.write_all(&body)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    }
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)
}

#[cfg(unix)]
fn open_private(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    // umask に関わらず 0600 にする
    f.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(f)
}

#[cfg(not(unix))]
fn open_private(path: &Path) -> std::io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// アプリが持つ履歴。`path` が無いとき（データのディレクトリが分からない）は、ディスクに残さない。
pub struct ClipboardHistory {
    history: Mutex<History>,
    path: Option<PathBuf>,
}

impl ClipboardHistory {
    fn new(path: Option<PathBuf>) -> Self {
        let history = path
            .as_deref()
            .map(|p| History::load(p, now_ms()))
            .unwrap_or_default();
        ClipboardHistory {
            history: Mutex::new(history),
            path,
        }
    }

    /// 履歴を変え、変わったらファイルに書いて画面に知らせる。
    fn update(&self, app: &AppHandle, f: impl FnOnce(&mut History) -> bool) {
        let mut h = self.history.lock().unwrap_or_else(|e| e.into_inner());
        if !f(&mut h) {
            return;
        }
        if let Some(p) = &self.path {
            if let Err(e) = h.save(p) {
                eprintln!("kisui-terminal: cannot save the clipboard history: {e}");
            }
        }
        drop(h);
        let _ = app.emit_to("main", EVENT_CHANGED, ());
    }

    /// `text` が履歴にあるか。
    pub fn contains(&self, text: &str) -> bool {
        let h = self.history.lock().unwrap_or_else(|e| e.into_inner());
        h.entries().iter().any(|e| e.text == text)
    }
}

/// 履歴（新しいものが先頭）。メイン窓と、kisui-terminal の外から開く履歴の窓（clipboard_popup.rs）の画面からだけ呼べる。
#[tauri::command]
pub fn clipboard_history_list(
    webview: Webview,
    app: AppHandle,
    state: State<ClipboardHistory>,
) -> Result<Vec<Entry>, String> {
    if webview.label() != crate::clipboard_popup::LABEL {
        crate::browser::from_main(&webview)?;
    }
    state.update(&app, |h| h.prune(now_ms()));
    let h = state.history.lock().unwrap_or_else(|e| e.into_inner());
    Ok(h.entries().to_vec())
}

/// 履歴を読み込んで `app` に持たせ、クリップボードの見張りを始める。
pub fn start(app: &AppHandle) {
    let path = app.path().app_data_dir().ok().map(|d| d.join(FILE_NAME));
    app.manage(ClipboardHistory::new(path));
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("clipboard-history".into())
            .spawn(move || watch(app));
        if let Err(e) = spawned {
            eprintln!("kisui-terminal: cannot watch the clipboard: {e}");
        }
    }
}

/// 一回調べた結果。
#[cfg(any(target_os = "macos", target_os = "linux", test))]
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
enum Seen {
    /// 前に調べたときから変わっていない（macOS の changeCount で分かるとき）
    Unchanged,
    /// 文字がある
    Text(String),
    /// 文字がある。前に調べたときからコピーされたことが分かっている（macOS の changeCount が変わったとき）。
    /// 前と同じ文字でも、もう一度コピーされたものとして入れる
    Copied(String),
    /// 「秘密」の印が付いている
    Concealed,
    /// 文字が無い
    Empty,
    /// 調べられなかった（次にまた調べる）
    Unknown,
}

/// 見張りの状態。前に見た文字を覚え、変わったときだけ履歴に入れる。
///
/// 起動して最初に読めた中身は、比べる元にするだけで履歴には入れない。起動したときの中身は「変化」ではなく、
/// 入れると、12 時間で消えた文が開き直すたびに新しい時刻で戻ってしまうため。
#[cfg(any(target_os = "macos", target_os = "linux", test))]
#[derive(Default)]
struct Watcher {
    /// 最初の中身を読めたか
    primed: bool,
    last: Option<String>,
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
impl Watcher {
    /// 見た結果を受け取り、履歴に入れる文字を返す。
    fn observe(&mut self, seen: Seen) -> Option<String> {
        if !self.primed {
            match seen {
                Seen::Unchanged | Seen::Unknown => {}
                Seen::Text(t) | Seen::Copied(t) => {
                    self.primed = true;
                    self.last = Some(t);
                }
                Seen::Concealed | Seen::Empty => self.primed = true,
            }
            return None;
        }
        match seen {
            Seen::Unchanged | Seen::Unknown => None,
            Seen::Concealed | Seen::Empty => {
                self.last = None;
                None
            }
            Seen::Copied(t) => {
                self.last = Some(t.clone());
                Some(t)
            }
            Seen::Text(t) => {
                if self.last.as_deref() == Some(t.as_str()) {
                    return None;
                }
                self.last = Some(t.clone());
                Some(t)
            }
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn watch(app: AppHandle) {
    let mut os = platform::Clipboard::new();
    let mut w = Watcher::default();
    loop {
        let seen = w.observe(os.read());
        if let Some(s) = app.try_state::<ClipboardHistory>() {
            let now = now_ms();
            s.update(&app, |h| {
                let added = seen.is_some_and(|t| h.add(&t, now));
                h.prune(now) || added
            });
        }
        std::thread::sleep(platform::INTERVAL);
    }
}

/// macOS：`NSPasteboard` の changeCount で変わったかを知り、変わったときだけ型と文字を読む。
#[cfg(target_os = "macos")]
mod platform {
    use std::time::Duration;

    use objc2::rc::autoreleasepool;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};

    use super::Seen;

    /// 調べる間隔。changeCount を見るだけでほぼ費用が無いので、コピーしてすぐ一覧を開いても入っているように短くする。
    pub const INTERVAL: Duration = Duration::from_millis(500);

    /// 履歴に入れない印（http://nspasteboard.org/）。
    const SKIP_TYPES: [&str; 2] = [
        "org.nspasteboard.ConcealedType",
        "org.nspasteboard.TransientType",
    ];

    /// 手元のクリップボード（`generalPasteboard`）を読むもの。最後に読めた changeCount を覚える。
    pub struct Clipboard {
        last_count: Option<isize>,
    }

    impl Clipboard {
        /// 前の changeCount を持たずに始める（初めての `read` は必ず中身を読む）。
        pub fn new() -> Self {
            Clipboard { last_count: None }
        }

        /// クリップボードを調べる。changeCount が前と同じなら `Unchanged`（中身は読まない）。変わっていれば、初めて読むときは
        /// `Text`、それ以外は `Copied`。ほかに `Concealed`・`Empty`、読んでいる間に変わったら `Unknown`（次にもう一度読む）。
        pub fn read(&mut self) -> Seen {
            autoreleasepool(|_| {
                let pb = NSPasteboard::generalPasteboard();
                let count = pb.changeCount();
                if self.last_count == Some(count) {
                    return Seen::Unchanged;
                }
                let types: Vec<String> = pb
                    .types()
                    .map(|a| a.to_vec().iter().map(|t| t.to_string()).collect())
                    .unwrap_or_default();
                let seen = if types.iter().any(|t| SKIP_TYPES.contains(&t.as_str())) {
                    Seen::Concealed
                } else {
                    match pb.stringForType(unsafe { NSPasteboardTypeString }) {
                        // 初めて読むときは、前の changeCount が無いので、コピーされたかは分からない
                        Some(s) if self.last_count.is_none() => Seen::Text(s.to_string()),
                        Some(s) => Seen::Copied(s.to_string()),
                        None => Seen::Empty,
                    }
                };
                // 読んでいる間に変わったら、次にもう一度読む
                if pb.changeCount() != count {
                    return Seen::Unknown;
                }
                self.last_count = Some(count);
                seen
            })
        }
    }
}

/// Linux：文字は arboard で読む（Wayland の data-control が無ければ X11）。「秘密」の印は、Wayland なら
/// wl-clipboard-rs、X11 なら TARGETS で型の一覧を取って確かめる。読む前と読んだ後の両方で確かめる。
#[cfg(target_os = "linux")]
mod platform {
    use std::time::{Duration, Instant};

    use wl_clipboard_rs::paste::{self as wl, ClipboardType, Seat};
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{
        Atom, AtomEnum, ConnectionExt as _, CreateWindowAux, Window, WindowClass,
    };
    use x11rb::protocol::Event;
    use x11rb::rust_connection::RustConnection;

    use super::Seen;

    /// 調べる間隔。変わったかを安く知る手段が無く、毎回中身を読む（X11 ならクリップボードの持ち主とやり取りする）ので、
    /// macOS より長くする。
    pub const INTERVAL: Duration = Duration::from_secs(1);

    /// KDE の Klipper などが使う「秘密」の印。
    const HINT: &str = "x-kde-passwordManagerHint";

    type Res<T> = Result<T, Box<dyn std::error::Error>>;

    /// 手元のクリップボードを読むもの。文字を読む arboard と、TARGETS を聞く X11 の接続を持ち、失敗したら次に作り直す。
    pub struct Clipboard {
        text: Option<arboard::Clipboard>,
        x11: Option<X11>,
    }

    impl Clipboard {
        /// まだつながない（初めて `read` するときにつなぐ）。
        pub fn new() -> Self {
            Clipboard {
                text: None,
                x11: None,
            }
        }

        /// クリップボードを調べる。`Text`（変わったかは分からないので、比べるのは `Watcher`）・`Concealed`・`Empty`・
        /// `Unknown` のどれか。「秘密」の印は、文字を読む前と後の両方で確かめる（その間に中身が変わることがあるため）。
        pub fn read(&mut self) -> Seen {
            if let Some(seen) = self.probe().stop() {
                return seen;
            }
            let text = match self.text() {
                Seen::Text(t) => t,
                other => return other,
            };
            self.probe().stop().unwrap_or(Seen::Text(text))
        }

        /// 文字。`Text`・`Empty`（文字が無い）・`Unknown`（読めなかった）のどれか。
        fn text(&mut self) -> Seen {
            if self.text.is_none() {
                self.text = arboard::Clipboard::new().ok();
            }
            let Some(cb) = self.text.as_mut() else {
                return Seen::Unknown;
            };
            match cb.get_text() {
                Ok(t) => Seen::Text(t),
                Err(arboard::Error::ContentNotAvailable) => Seen::Empty,
                Err(_) => {
                    self.text = None;
                    Seen::Unknown
                }
            }
        }

        /// 「秘密」の印があるかを、型の一覧で確かめる。
        fn probe(&mut self) -> Probe {
            if std::env::var_os("WAYLAND_DISPLAY").is_some() {
                match wl::get_mime_types(ClipboardType::Regular, Seat::Unspecified) {
                    Ok(types) if types.contains(HINT) => return Probe::Concealed,
                    Ok(_) => return Probe::Clear,
                    Err(wl::Error::NoSeats | wl::Error::ClipboardEmpty | wl::Error::NoMimeType) => {
                        return Probe::Empty
                    }
                    // data-control が無い（GNOME など）。XWayland の X11 で確かめる
                    Err(_) => {}
                }
            }
            if self.x11.is_none() {
                self.x11 = X11::new().ok();
            }
            let Some(x) = self.x11.as_ref() else {
                return Probe::Unknown;
            };
            match x.has_target(x.hint) {
                Ok(Some(true)) => Probe::Concealed,
                Ok(Some(false)) => Probe::Clear,
                Ok(None) => Probe::Empty,
                Err(_) => {
                    self.x11 = None;
                    Probe::Unknown
                }
            }
        }
    }

    /// 型の一覧で確かめた結果。
    enum Probe {
        /// 「秘密」の印が無い（文字を読んでよい）
        Clear,
        /// 「秘密」の印がある
        Concealed,
        /// クリップボードが空
        Empty,
        /// 確かめられなかった
        Unknown,
    }

    impl Probe {
        /// 文字を読まずに止めるときの結果。読んでよい（`Clear`）なら None。
        fn stop(self) -> Option<Seen> {
            match self {
                Probe::Clear => None,
                Probe::Concealed => Some(Seen::Concealed),
                Probe::Empty => Some(Seen::Empty),
                Probe::Unknown => Some(Seen::Unknown),
            }
        }
    }

    /// X11 の CLIPBOARD の TARGETS を聞くための接続と窓。
    struct X11 {
        conn: RustConnection,
        win: Window,
        clipboard: Atom,
        targets: Atom,
        prop: Atom,
        hint: Atom,
    }

    impl X11 {
        fn new() -> Res<Self> {
            let (conn, screen) = x11rb::connect(None)?;
            let root = conn.setup().roots[screen].root;
            let win = conn.generate_id()?;
            conn.create_window(
                x11rb::COPY_DEPTH_FROM_PARENT,
                win,
                root,
                0,
                0,
                1,
                1,
                0,
                WindowClass::INPUT_OUTPUT,
                x11rb::COPY_FROM_PARENT,
                &CreateWindowAux::new(),
            )?;
            let atom = |name: &str| -> Res<Atom> {
                Ok(conn.intern_atom(false, name.as_bytes())?.reply()?.atom)
            };
            let clipboard = atom("CLIPBOARD")?;
            let targets = atom("TARGETS")?;
            let prop = atom("KISUI_CLIPBOARD_TARGETS")?;
            let hint = atom(HINT)?;
            conn.flush()?;
            Ok(X11 {
                conn,
                win,
                clipboard,
                targets,
                prop,
                hint,
            })
        }

        /// CLIPBOARD の型の一覧に `target` があるか。持ち主がいなければ None。
        fn has_target(&self, target: Atom) -> Res<Option<bool>> {
            self.conn.convert_selection(
                self.win,
                self.clipboard,
                self.targets,
                self.prop,
                x11rb::CURRENT_TIME,
            )?;
            self.conn.flush()?;
            let deadline = Instant::now() + Duration::from_millis(500);
            loop {
                match self.conn.poll_for_event()? {
                    Some(Event::SelectionNotify(e)) if e.requestor == self.win => {
                        if e.property == x11rb::NONE {
                            return Ok(None);
                        }
                        let r = self
                            .conn
                            .get_property(true, self.win, self.prop, AtomEnum::ATOM, 0, 4096)?
                            .reply()?;
                        let found = r
                            .value32()
                            .map(|mut it| it.any(|a| a == target))
                            .unwrap_or(false);
                        return Ok(Some(found));
                    }
                    Some(_) => {}
                    None if Instant::now() >= deadline => {
                        return Err("no reply to TARGETS".into());
                    }
                    None => std::thread::sleep(Duration::from_millis(10)),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: u64 = 60 * 60 * 1000;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kisui-cliphist-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn texts(h: &History) -> Vec<&str> {
        h.entries().iter().map(|e| e.text.as_str()).collect()
    }

    #[test]
    fn add_puts_newest_first_and_moves_duplicates() {
        let mut h = History::default();
        assert!(h.add("a", 1));
        assert!(h.add("b", 2));
        assert!(!h.add("b", 3), "same as the newest: nothing changes");
        assert_eq!(h.entries()[0].copied_at, 2);
        assert!(h.add("a", 4));
        assert_eq!(texts(&h), ["a", "b"]);
        assert_eq!(h.entries()[0].copied_at, 4);
    }

    #[test]
    fn add_skips_empty_and_too_large_text() {
        let mut h = History::default();
        assert!(!h.add("", 1));
        assert!(!h.add(&"x".repeat(MAX_TEXT_BYTES + 1), 1));
        assert!(h.add(&"x".repeat(MAX_TEXT_BYTES), 1));
        assert_eq!(h.entries().len(), 1);
    }

    #[test]
    fn keeps_at_most_max_entries_dropping_the_oldest() {
        let mut h = History::default();
        for i in 0..(MAX_ENTRIES as u64 + 5) {
            h.add(&i.to_string(), i);
        }
        assert_eq!(h.entries().len(), MAX_ENTRIES);
        assert_eq!(h.entries()[0].text, (MAX_ENTRIES + 4).to_string());
        assert_eq!(h.entries()[MAX_ENTRIES - 1].text, "5");
    }

    #[test]
    fn prune_clamps_entries_from_the_future() {
        let mut h = History::default();
        h.add("future", 100 * HOUR);
        assert!(h.prune(HOUR), "clamped to now");
        assert_eq!(h.entries()[0].copied_at, HOUR);
        assert!(!h.prune(HOUR));
        assert!(h.prune(13 * HOUR), "expires 12 hours after now");
        assert!(h.entries().is_empty());
    }

    #[test]
    fn prune_removes_entries_older_than_12_hours() {
        let mut h = History::default();
        let base = 100 * HOUR;
        h.add("old", base);
        h.add("edge", base + 1);
        h.add("new", base + 6 * HOUR);
        assert!(!h.prune(base + 12 * HOUR - 1));
        assert!(h.prune(base + 12 * HOUR));
        assert_eq!(texts(&h), ["new", "edge"]);
        assert!(h.prune(base + 12 * HOUR + 1));
        assert_eq!(texts(&h), ["new"]);
        assert!(h.prune(base + 18 * HOUR));
        assert!(h.entries().is_empty());
    }

    #[test]
    fn save_and_load_round_trip_with_private_file() {
        let dir = tmp("roundtrip");
        let path = dir.join("sub").join(FILE_NAME);
        let mut h = History::default();
        h.add("one", 10 * HOUR);
        h.add("two\nlines", 11 * HOUR);
        h.save(&path).unwrap();
        assert_eq!(History::load(&path, 12 * HOUR), h);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        // 書き直しても 0600 のまま、一時ファイルは残らない
        h.add("three", 12 * HOUR);
        h.save(&path).unwrap();
        assert_eq!(History::load(&path, 12 * HOUR), h);
        assert!(!path.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_drops_expired_entries_and_survives_bad_files() {
        let dir = tmp("load");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        assert!(History::load(&path, 0).entries().is_empty(), "no file");
        fs::write(&path, b"{not json").unwrap();
        assert!(History::load(&path, 0).entries().is_empty(), "broken file");
        fs::write(
            &path,
            br#"{"version":99,"entries":[{"text":"a","copiedAt":1}]}"#,
        )
        .unwrap();
        assert!(
            History::load(&path, 1).entries().is_empty(),
            "other version"
        );

        let mut h = History::default();
        h.add("old", HOUR);
        h.add("new", 10 * HOUR);
        h.save(&path).unwrap();
        let loaded = History::load(&path, 13 * HOUR);
        assert_eq!(texts(&loaded), ["new"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn watcher_reports_only_changes_and_forgets_after_concealed() {
        let mut w = Watcher::default();
        assert_eq!(w.observe(Seen::Empty), None, "first content is a baseline");
        assert_eq!(w.observe(Seen::Text("a".into())), Some("a".into()));
        assert_eq!(w.observe(Seen::Text("a".into())), None);
        assert_eq!(w.observe(Seen::Unknown), None);
        assert_eq!(w.observe(Seen::Unchanged), None);
        assert_eq!(w.observe(Seen::Text("a".into())), None);
        assert_eq!(w.observe(Seen::Concealed), None);
        assert_eq!(w.observe(Seen::Text("a".into())), Some("a".into()));
        assert_eq!(w.observe(Seen::Empty), None);
        assert_eq!(w.observe(Seen::Text("b".into())), Some("b".into()));
    }

    #[test]
    fn watcher_takes_a_known_copy_of_the_same_text_again() {
        let mut w = Watcher::default();
        assert_eq!(w.observe(Seen::Text("a".into())), None, "baseline");
        assert_eq!(w.observe(Seen::Copied("a".into())), Some("a".into()));
        assert_eq!(w.observe(Seen::Copied("a".into())), Some("a".into()));
        assert_eq!(w.observe(Seen::Text("a".into())), None);
    }

    #[test]
    fn reopening_does_not_bring_back_expired_text() {
        let dir = tmp("reopen");
        let path = dir.join(FILE_NAME);
        // 「a」をコピーして閉じる
        let mut h = History::default();
        let mut w = Watcher::default();
        assert_eq!(w.observe(Seen::Empty), None);
        h.add(&w.observe(Seen::Text("a".into())).unwrap(), HOUR);
        h.save(&path).unwrap();
        // 13 時間後に開き直す。クリップボードには「a」が残っている
        let now = 14 * HOUR;
        let mut h = History::load(&path, now);
        assert!(h.entries().is_empty());
        let mut w = Watcher::default();
        assert_eq!(w.observe(Seen::Unknown), None);
        assert_eq!(w.observe(Seen::Text("a".into())), None);
        assert_eq!(w.observe(Seen::Text("a".into())), None);
        assert!(!h.prune(now));
        assert!(h.entries().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
