//! 内蔵ブラウザのダウンロード（#204）。
//!
//! タブのページがファイルをダウンロードしたら、OS のダウンロードのフォルダ（`~/Downloads`）に、場所を聞かずに保存する。
//! 同じ名前のファイルがあれば、`名前 (1).拡張子` `名前 (2).拡張子` … と番号を付ける（wry と同じ付け方）。
//! 終わったら画面に知らせ（`browser-download`）、画面は右下のお知らせに出す。お知らせから、ファイルを開く・フォルダを表示する。
//! 開く・表示するのは、ここで保存したファイルだけ（画面は番号で頼む。パスは受けない）。
//!
//! 受け方は OS で違う:
//! - Linux（WebKitGTK）：ダウンロードは WebKitWebContext（Cookie などのページのデータの単位）に届く。タブは共有のデータを
//!   使うので、wry の受け口（webview ごとに WebContext に足す）だと、タブの数だけ重なり、最初のタブを閉じると断るようになる。
//!   そこで、WebContext ごとに 1 度だけ、ここで直接受ける（`watch`）。
//! - macOS（WKWebView）：webview ごとに受ける（tauri の `on_download`）。終わったときにパスが来ないので、始めたときに覚える。

#[cfg(target_os = "macos")]
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Webview};

use crate::open_url::from_main;

/// 画面に知らせるイベント。
const EVENT_DOWNLOAD: &str = "browser-download";
/// 名前が分からないときの名前。
const FALLBACK_NAME: &str = "download";
/// ファイルの名前の長さの上限（バイト。多くのファイルシステムの上限 255 より、番号の分だけ短く）。
const MAX_NAME: usize = 200;
/// 覚えておく保存したファイルの数の上限（古いものから忘れる）。
const MAX_DONE: usize = 100;

/// ダウンロードが終わった（画面のお知らせ）。
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DownloadEvent {
    /// 開く・表示するときの番号。保存できなかったときは 0
    pub id: u64,
    /// ファイルの名前
    pub name: String,
    /// 保存したフォルダ
    pub dir: String,
    pub ok: bool,
}

/// 保存したファイル（番号 → パス）。
#[derive(Default)]
pub struct Downloads {
    next: AtomicU64,
    done: Mutex<Vec<(u64, PathBuf)>>,
    /// 始めたダウンロード（URL → 保存先）。macOS は終わったときにパスが来ないため
    #[cfg(target_os = "macos")]
    pending: Mutex<HashMap<String, Vec<PathBuf>>>,
}

impl Downloads {
    fn remember(&self, path: PathBuf) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let mut d = self.done.lock().unwrap_or_else(|e| e.into_inner());
        d.push((id, path));
        let over = d.len().saturating_sub(MAX_DONE);
        d.drain(..over);
        id
    }

    fn path(&self, id: u64) -> Option<PathBuf> {
        let d = self.done.lock().unwrap_or_else(|e| e.into_inner());
        d.iter().find(|(i, _)| *i == id).map(|(_, p)| p.clone())
    }
}

/// ページが勧めたファイルの名前を、ダウンロードのフォルダの中の 1 つの名前にする
/// （フォルダの区切り・制御文字を除き、`.` `..` と空は既定の名前にし、長すぎるものは切る）。
pub fn file_name(suggested: &str) -> String {
    // 区切りがあれば最後の部分だけ（`../x` や `a/b` でフォルダの外・下に書かない）
    let last = suggested.rsplit(['/', '\\']).next().unwrap_or("");
    let mut s: String = last.chars().filter(|c| !c.is_control()).collect();
    s = s.trim().to_string();
    if s.is_empty() || s == "." || s == ".." {
        return FALLBACK_NAME.to_string();
    }
    if s.len() > MAX_NAME {
        // 拡張子は残す（短いときだけ）
        let (base, ext) = split_ext(&s);
        let ext = if ext.len() <= 16 { ext } else { "" };
        let mut b = base.to_string();
        while b.len() + ext.len() > MAX_NAME {
            b.pop();
        }
        s = format!("{b}{ext}");
    }
    s
}

/// 名前を、番号を入れる前と後ろ（`.` から）に分ける。`a.tar.gz` は `a` と `.tar.gz`。`.bashrc` のような頭の `.` は拡張子にしない。
fn split_ext(name: &str) -> (&str, &str) {
    let first = name.chars().next().map_or(0, char::len_utf8);
    match name[first..].find('.') {
        Some(i) => name.split_at(first + i),
        None => (name, ""),
    }
}

/// dir の中で、まだ無い名前のパス（`名前 (1).拡張子` … と番号を付ける）。
pub fn unique_path(dir: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    let (base, ext) = split_ext(name);
    let mut n = 1u32;
    loop {
        let p = dir.join(format!("{base} ({n}){ext}"));
        if !exists(&p) || n == u32::MAX {
            return p;
        }
        n += 1;
    }
}

/// 保存先のフォルダ（OS のダウンロードのフォルダ。分からなければホームの Downloads）。
fn download_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .download_dir()
        .ok()
        .or_else(|| app.path().home_dir().ok().map(|h| h.join("Downloads")))
}

/// ページが勧めた名前から、保存先を決める。フォルダが無ければ作る。
fn destination(app: &AppHandle, suggested: &str) -> Option<PathBuf> {
    let dir = download_dir(app)?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(unique_path(&dir, &file_name(suggested), |p| {
        p.symlink_metadata().is_ok()
    }))
}

/// 終わった（ok なら path に保存した）ことを画面に知らせる。
fn finished(app: &AppHandle, path: &Path, ok: bool) {
    let id = match (ok, app.try_state::<Downloads>()) {
        (true, Some(d)) => d.remember(path.to_path_buf()),
        _ => 0,
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let dir = path
        .parent()
        .map(|d| d.display().to_string())
        .unwrap_or_default();
    let _ = app.emit(EVENT_DOWNLOAD, DownloadEvent { id, name, dir, ok });
}

/// WebKitGTK のデータ（WebContext）のダウンロードを受ける。同じ WebContext には 1 度だけ足す（メインスレッドで呼ぶ）。
#[cfg(target_os = "linux")]
pub fn watch(app: &AppHandle, ctx: &webkit2gtk::WebContext) {
    use std::cell::RefCell;
    use std::rc::Rc;

    use webkit2gtk::glib::prelude::ObjectExt;
    use webkit2gtk::{DownloadExt, WebContextExt};

    const MARK: &str = "kisui-terminal-downloads";
    // SAFETY: この印には bool しか入れず、読むのもここだけ（型が食い違わない）
    if unsafe { ctx.data::<bool>(MARK) }.is_some() {
        return;
    }
    unsafe { ctx.set_data(MARK, true) };
    let app = app.clone();
    ctx.connect_download_started(move |_, download| {
        let dest: Rc<RefCell<Option<PathBuf>>> = Rc::default();
        let failed = Rc::new(RefCell::new(false));
        {
            let (app, dest) = (app.clone(), Rc::clone(&dest));
            download.connect_decide_destination(move |d, suggested| {
                let Some(p) = destination(&app, suggested) else {
                    d.cancel();
                    return true;
                };
                // WebKitGTK 4.1 の保存先は file: の URI で渡す
                match tauri::Url::from_file_path(&p) {
                    Ok(u) => {
                        d.set_destination(u.as_str());
                        *dest.borrow_mut() = Some(p);
                    }
                    Err(()) => d.cancel(),
                }
                true
            });
        }
        {
            let failed = Rc::clone(&failed);
            download.connect_failed(move |_, _| *failed.borrow_mut() = true);
        }
        let app = app.clone();
        download.connect_finished(move |_| {
            let Some(p) = dest.borrow_mut().take() else {
                return;
            };
            finished(&app, &p, !*failed.borrow());
        });
    });
}

/// macOS：ダウンロードを始める（保存先を決めて覚える）・終わった（覚えた保存先で知らせる）。tauri の `on_download` から呼ぶ。
#[cfg(target_os = "macos")]
pub fn on_download(app: &AppHandle, ev: tauri::webview::DownloadEvent<'_>) -> bool {
    use tauri::webview::DownloadEvent as E;
    let Some(state) = app.try_state::<Downloads>() else {
        return false;
    };
    match ev {
        E::Requested {
            url,
            destination: d,
        } => {
            // wry が勧めた名前（ページの勧めた名前に、wry が番号を付けたもの）から、名前だけを取って決め直す
            let suggested = d
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let Some(p) = destination(app, &suggested) else {
                return false;
            };
            *d = p.clone();
            let mut pending = state.pending.lock().unwrap_or_else(|e| e.into_inner());
            pending.entry(url.to_string()).or_default().push(p);
            true
        }
        E::Finished { url, success, .. } => {
            let p = {
                let mut pending = state.pending.lock().unwrap_or_else(|e| e.into_inner());
                let Some(list) = pending.get_mut(url.as_str()) else {
                    return true;
                };
                let p = list.remove(0);
                if list.is_empty() {
                    pending.remove(url.as_str());
                }
                p
            };
            finished(app, &p, success);
            true
        }
        _ => true,
    }
}

/// `open`（macOS）・`xdg-open`（それ以外）に引数を渡して動かす。
fn run_opener(args: &[&std::ffi::OsStr]) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|mut c| {
            std::thread::spawn(move || {
                let _ = c.wait();
            });
        })
        .map_err(|e| format!("failed to start {opener}: {e}"))
}

fn saved(d: &Downloads, id: u64) -> Result<PathBuf, String> {
    let p = d.path(id).ok_or_else(|| "no such download".to_string())?;
    if p.symlink_metadata().is_err() {
        return Err(format!("{} is not there any more", p.display()));
    }
    Ok(p)
}

/// ダウンロードしたファイルを、OS の既定のアプリで開く。
#[tauri::command]
pub fn download_open(d: State<Downloads>, webview: Webview, id: u64) -> Result<(), String> {
    from_main(&webview)?;
    let p = saved(&d, id)?;
    run_opener(&[p.as_os_str()])
}

/// ダウンロードしたファイルのフォルダを表示する（macOS は Finder でファイルを選んだ状態で。Linux はフォルダを開く）。
#[tauri::command]
pub fn download_reveal(d: State<Downloads>, webview: Webview, id: u64) -> Result<(), String> {
    from_main(&webview)?;
    let p = saved(&d, id)?;
    if cfg!(target_os = "macos") {
        run_opener(&["-R".as_ref(), p.as_os_str()])
    } else {
        let dir = p.parent().ok_or_else(|| "no folder".to_string())?;
        run_opener(&[dir.as_os_str()])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn names_stay_inside_the_folder() {
        assert_eq!(file_name("report.pdf"), "report.pdf");
        assert_eq!(file_name("../../etc/passwd"), "passwd");
        assert_eq!(file_name("a/b/c.txt"), "c.txt");
        assert_eq!(file_name("a\\b.txt"), "b.txt");
        assert_eq!(file_name("x\ny\u{7}.txt"), "xy.txt");
        for bad in ["", ".", "..", "dir/", "  "] {
            assert_eq!(file_name(bad), FALLBACK_NAME, "{bad:?}");
        }
        let long = format!("{}.zip", "a".repeat(400));
        let n = file_name(&long);
        assert!(n.len() <= MAX_NAME, "{}", n.len());
        assert!(n.ends_with(".zip"));
        // 長い字が多バイトでも、字の途中で切らない
        let n = file_name(&"あ".repeat(200));
        assert!(n.len() <= MAX_NAME && n.chars().all(|c| c == 'あ'));
    }

    #[test]
    fn same_names_get_numbers() {
        let dir = Path::new("/d");
        let taken: HashSet<PathBuf> = ["/d/a.tar.gz", "/d/a (1).tar.gz", "/d/b", "/d/.rc"]
            .iter()
            .map(PathBuf::from)
            .collect();
        let ex = |p: &Path| taken.contains(p);
        assert_eq!(unique_path(dir, "new.txt", ex), PathBuf::from("/d/new.txt"));
        assert_eq!(
            unique_path(dir, "a.tar.gz", ex),
            PathBuf::from("/d/a (2).tar.gz")
        );
        assert_eq!(unique_path(dir, "b", ex), PathBuf::from("/d/b (1)"));
        assert_eq!(unique_path(dir, ".rc", ex), PathBuf::from("/d/.rc (1)"));
        assert_eq!(
            unique_path(dir, "あ.txt", |p| p == Path::new("/d/あ.txt")),
            PathBuf::from("/d/あ (1).txt")
        );
    }

    #[test]
    fn remembers_only_the_last_downloads() {
        let d = Downloads::default();
        let first = d.remember(PathBuf::from("/d/0"));
        assert_eq!(d.path(first), Some(PathBuf::from("/d/0")));
        for i in 0..MAX_DONE {
            d.remember(PathBuf::from(format!("/d/{}", i + 1)));
        }
        assert_eq!(d.path(first), None);
        assert_eq!(
            d.path(first + MAX_DONE as u64),
            Some(PathBuf::from(format!("/d/{MAX_DONE}")))
        );
        assert_eq!(d.path(0), None);
    }
}
