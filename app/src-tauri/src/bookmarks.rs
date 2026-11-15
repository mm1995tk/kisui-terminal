//! 内蔵ブラウザのブックマーク（#205）。すべてのワークスペースで共有し、データのフォルダの `browser-bookmarks.json` に覚える
//! （開いていたタブの `browser-tabs.json` と同じ場所。自分だけが読めるファイル）。
//! 並び・足す・消すは画面（`app/src/browser/bookmarks.ts`）が決め、ここは丸ごと読む・書くだけ。

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Webview};

use crate::open_url::{from_main, parse_url};

/// 覚えるファイル（データのフォルダの中）。
const FILE: &str = "browser-bookmarks.json";
/// 覚えるファイルの形式の版。
const FORMAT_VERSION: u32 = 1;
/// 覚えるブックマークの数の上限。
pub const MAX_BOOKMARKS: usize = 5000;
/// URL と題の長さの上限（バイト）。
const MAX_URL: usize = 4096;
const MAX_TITLE: usize = 1024;

/// ブックマーク 1 つ。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bookmark {
    pub url: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Serialize, Deserialize)]
struct StoredFile {
    version: u32,
    #[serde(default)]
    bookmarks: Vec<Bookmark>,
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(FILE))
        .map_err(|e| e.to_string())
}

/// 書いてよいブックマークか（開ける URL で、長すぎない）。
fn valid(b: &Bookmark) -> bool {
    b.url.len() <= MAX_URL && b.title.len() <= MAX_TITLE && parse_url(&b.url).is_ok()
}

/// 覚えたブックマークを読む。無い・壊れている・版が違うときは空。開けない URL のものは捨てる。
pub fn load(path: &Path) -> Vec<Bookmark> {
    let text = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            eprintln!("kisui-terminal: cannot read {}: {e}", path.display());
            return Vec::new();
        }
    };
    match serde_json::from_slice::<StoredFile>(&text) {
        Ok(f) if f.version == FORMAT_VERSION => {
            let mut v = f.bookmarks;
            v.retain(valid);
            v.truncate(MAX_BOOKMARKS);
            v
        }
        _ => Vec::new(),
    }
}

/// ブックマークを覚える（自分だけが読めるファイル。書きかけを残さないよう、別の名前に書いてから置き換える）。
pub fn save(path: &Path, list: &[Bookmark]) -> std::io::Result<()> {
    let body = serde_json::to_vec(&StoredFile {
        version: FORMAT_VERSION,
        bookmarks: list.to_vec(),
    })
    .map_err(std::io::Error::other)?;
    crate::browser::write_private(path, &body)
}

/// 覚えたブックマーク。
#[tauri::command]
pub fn browser_bookmarks_load(app: AppHandle, webview: Webview) -> Result<Vec<Bookmark>, String> {
    from_main(&webview)?;
    Ok(load(&path(&app)?))
}

/// ブックマークを覚える（丸ごと置き換える）。
#[tauri::command(async)]
pub fn browser_bookmarks_save(
    app: AppHandle,
    webview: Webview,
    bookmarks: Vec<Bookmark>,
) -> Result<(), String> {
    from_main(&webview)?;
    if bookmarks.len() > MAX_BOOKMARKS || !bookmarks.iter().all(valid) {
        return Err("invalid bookmarks".into());
    }
    save(&path(&app)?, &bookmarks).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kisui-bookmarks-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn round_trip_in_a_private_file() {
        let d = temp_dir("rt");
        let p = d.join("sub").join(FILE);
        assert_eq!(load(&p), Vec::new());
        let list = vec![
            Bookmark {
                url: "https://example.com/".into(),
                title: "Example".into(),
            },
            Bookmark {
                url: "http://localhost:3000/".into(),
                title: String::new(),
            },
        ];
        save(&p, &list).unwrap();
        assert_eq!(load(&p), list);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn broken_or_unsafe_bookmarks_are_dropped() {
        let d = temp_dir("broken");
        fs::create_dir_all(&d).unwrap();
        let p = d.join(FILE);
        fs::write(&p, "{").unwrap();
        assert_eq!(load(&p), Vec::new());
        fs::write(&p, r#"{"version":99,"bookmarks":[]}"#).unwrap();
        assert_eq!(load(&p), Vec::new());
        fs::write(
            &p,
            r#"{"version":1,"bookmarks":[
              {"url":"https://a.example/","title":"A"},
              {"url":"javascript:alert(1)","title":"js"},
              {"url":"file:///etc/passwd"},
              {"url":"https://b.example/"}
            ]}"#,
        )
        .unwrap();
        let got = load(&p);
        assert_eq!(
            got.iter().map(|b| b.url.as_str()).collect::<Vec<_>>(),
            ["https://a.example/", "https://b.example/"]
        );
        assert_eq!(got[1].title, "");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn only_openable_urls_are_valid() {
        let b = |url: &str, title: &str| Bookmark {
            url: url.into(),
            title: title.into(),
        };
        assert!(valid(&b("https://a.example/", "A")));
        assert!(!valid(&b("javascript:alert(1)", "")));
        assert!(!valid(&b("https://a.example/", &"x".repeat(MAX_TITLE + 1))));
        assert!(!valid(&b(
            &format!("https://a.example/{}", "x".repeat(MAX_URL)),
            ""
        )));
    }
}
