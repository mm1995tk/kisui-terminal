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

// ---- Chrome のブックマーク（#239）。読むだけで、Chrome のファイルには書かない ----

/// 読む Chrome のプロファイル（Chrome の既定のプロファイルのフォルダ名）。
const CHROME_PROFILE: &str = "Default";
/// Chrome のブックマークのファイルの大きさの上限（バイト。これより大きければ読まない）。
const MAX_CHROME_FILE: u64 = 64 * 1024 * 1024;
/// Chrome のフォルダの入れ子をたどる深さの上限。
const MAX_DEPTH: usize = 32;

/// Chrome のブックマーク 1 つ。folder は、Chrome の中のフォルダの道（`Bookmarks bar / Dev` のように。直下なら根の名前だけ）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChromeBookmark {
    pub url: String,
    pub title: String,
    pub folder: String,
}

/// Chrome のブックマークのファイル。`home` は `$HOME`。macOS は `~/Library/Application Support/Google/Chrome/<プロファイル>/Bookmarks`、
/// それ以外（Linux）は `~/.config/google-chrome/<プロファイル>/Bookmarks`。
fn chrome_file(home: &Path, profile: &str) -> PathBuf {
    let base = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Google/Chrome")
    } else {
        home.join(".config/google-chrome")
    };
    base.join(profile).join("Bookmarks")
}

fn walk_chrome(node: &serde_json::Value, path: &str, depth: usize, out: &mut Vec<ChromeBookmark>) {
    if depth > MAX_DEPTH || out.len() >= MAX_BOOKMARKS {
        return;
    }
    let name = node.get("name").and_then(|v| v.as_str()).unwrap_or("");
    match node.get("type").and_then(|v| v.as_str()) {
        Some("url") => {
            let url = node.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let b = Bookmark {
                url: url.to_string(),
                title: name.to_string(),
            };
            if valid(&b) {
                out.push(ChromeBookmark {
                    url: b.url,
                    title: b.title,
                    folder: path.to_string(),
                });
            }
        }
        Some("folder") => {
            let here = if path.is_empty() {
                name.to_string()
            } else {
                format!("{path} / {name}")
            };
            if let Some(children) = node.get("children").and_then(|v| v.as_array()) {
                for c in children {
                    walk_chrome(c, &here, depth + 1, out);
                }
            }
        }
        _ => {}
    }
}

/// Chrome のブックマークを読む（ブックマークバー、その他のブックマーク、モバイルの順）。ファイルが無い・壊れている・大きすぎるときは空
/// （Chrome が入っていない環境で、エラーにしない）。開けない URL のものは捨てる。
pub fn load_chrome(file: &Path) -> Vec<ChromeBookmark> {
    match fs::metadata(file) {
        Ok(m) if m.is_file() && m.len() <= MAX_CHROME_FILE => {}
        _ => return Vec::new(),
    }
    let Ok(text) = fs::read(file) else {
        return Vec::new();
    };
    let Ok(root) = serde_json::from_slice::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for key in ["bookmark_bar", "other", "synced"] {
        if let Some(n) = root.get("roots").and_then(|r| r.get(key)) {
            walk_chrome(n, "", 0, &mut out);
        }
    }
    out
}

/// Chrome のブックマーク（読むだけ。開くたびに読み直す）。
#[tauri::command(async)]
pub fn browser_chrome_bookmarks_load(webview: Webview) -> Result<Vec<ChromeBookmark>, String> {
    from_main(&webview)?;
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Ok(Vec::new());
    };
    Ok(load_chrome(&chrome_file(&home, CHROME_PROFILE)))
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

    #[test]
    fn chrome_bookmarks_are_read_with_their_folders_and_never_written() {
        let d = temp_dir("chrome");
        fs::create_dir_all(&d).unwrap();
        let p = d.join("Bookmarks");
        assert_eq!(load_chrome(&p), Vec::new());
        fs::write(&p, "{").unwrap();
        assert_eq!(load_chrome(&p), Vec::new());
        let body = r#"{"roots":{
          "bookmark_bar":{"type":"folder","name":"Bookmarks bar","children":[
            {"type":"url","name":"A","url":"https://a.example/"},
            {"type":"folder","name":"Dev","children":[
              {"type":"url","name":"B","url":"https://b.example/"},
              {"type":"url","name":"js","url":"javascript:alert(1)"}
            ]}
          ]},
          "other":{"type":"folder","name":"Other bookmarks","children":[
            {"type":"url","name":"C","url":"http://localhost:3000/"}
          ]}
        }}"#;
        fs::write(&p, body).unwrap();
        let got = load_chrome(&p);
        let v: Vec<_> = got
            .iter()
            .map(|b| (b.url.as_str(), b.title.as_str(), b.folder.as_str()))
            .collect();
        assert_eq!(
            v,
            [
                ("https://a.example/", "A", "Bookmarks bar"),
                ("https://b.example/", "B", "Bookmarks bar / Dev"),
                ("http://localhost:3000/", "C", "Other bookmarks"),
            ]
        );
        assert_eq!(fs::read_to_string(&p).unwrap(), body);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn chrome_file_is_under_the_profile() {
        let p = chrome_file(Path::new("/h"), "Default");
        assert!(p.ends_with("Default/Bookmarks"));
        assert!(p.starts_with("/h"));
    }
}
