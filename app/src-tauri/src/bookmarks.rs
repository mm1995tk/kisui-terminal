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

/// Chrome のブックマークの木の節。Chrome のファイルと同じ入れ子で、フォルダの中の並びも Chrome の順のまま（#275）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ChromeNode {
    Folder {
        name: String,
        children: Vec<ChromeNode>,
    },
    Url {
        url: String,
        title: String,
    },
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

/// 節 1 つを木にする。数えるのは、残したブックマーク（count。MAX_BOOKMARKS まで）。開けない URL のものと、深すぎるフォルダの先は捨てる。
fn walk_chrome(node: &serde_json::Value, depth: usize, count: &mut usize) -> Option<ChromeNode> {
    if depth > MAX_DEPTH || *count >= MAX_BOOKMARKS {
        return None;
    }
    let name = node.get("name").and_then(|v| v.as_str()).unwrap_or("");
    match node.get("type").and_then(|v| v.as_str()) {
        Some("url") => {
            let url = node.get("url").and_then(|v| v.as_str()).unwrap_or("");
            // 題が長すぎても、URL が正しければ残す（覚えるファイルには入らないので、字の境目で切る）
            let mut title = name.to_string();
            if title.len() > MAX_TITLE {
                let mut end = MAX_TITLE;
                while !title.is_char_boundary(end) {
                    end -= 1;
                }
                title.truncate(end);
            }
            let b = Bookmark {
                url: url.to_string(),
                title,
            };
            if !valid(&b) {
                return None;
            }
            *count += 1;
            Some(ChromeNode::Url {
                url: b.url,
                title: b.title,
            })
        }
        Some("folder") => {
            let children = node
                .get("children")
                .and_then(|v| v.as_array())
                .map(|cs| {
                    cs.iter()
                        .filter_map(|c| walk_chrome(c, depth + 1, count))
                        .collect()
                })
                .unwrap_or_default();
            Some(ChromeNode::Folder {
                name: name.to_string(),
                children,
            })
        }
        _ => None,
    }
}

/// Chrome のブックマークを読めなかった理由（#265）。ファイルが無いのは理由にしない（Chrome が入っていない環境で、お知らせを出さない）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeProblem {
    /// 読もうとしたファイル
    pub path: String,
    /// 理由（OS のエラーの文、または壊れている・大きすぎるなどの短い文）
    pub reason: String,
    /// macOS で権限が無いための失敗か（画面が、フルディスクアクセスの案内を添える）
    pub needs_permission: bool,
}

/// Chrome のブックマークを読んだ結果。roots は根のフォルダ（ブックマークバー、その他のブックマーク、モバイルの順）。読めなかったときは roots が空で、problem に理由が入る。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct ChromeLoad {
    pub roots: Vec<ChromeNode>,
    pub problem: Option<ChromeProblem>,
}

fn fail(file: &Path, reason: String, needs_permission: bool) -> ChromeLoad {
    ChromeLoad {
        roots: Vec::new(),
        problem: Some(ChromeProblem {
            path: file.display().to_string(),
            reason,
            needs_permission,
        }),
    }
}

fn io_fail(file: &Path, e: &std::io::Error) -> ChromeLoad {
    fail(
        file,
        e.to_string(),
        cfg!(target_os = "macos") && e.kind() == ErrorKind::PermissionDenied,
    )
}

/// Chrome のブックマークを読む（ブックマークバー、その他のブックマーク、モバイルの順）。ファイルが無いときは空で理由も無し
/// （Chrome が入っていない環境で、エラーにしない）。権限が無い・読み込みの失敗・壊れている・大きすぎるときは、空と理由。
/// 開けない URL のものは捨てる。
pub fn load_chrome(file: &Path) -> ChromeLoad {
    let meta = match fs::metadata(file) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => return ChromeLoad::default(),
        Err(e) => return io_fail(file, &e),
    };
    if !meta.is_file() {
        return fail(file, "not a regular file".into(), false);
    }
    if meta.len() > MAX_CHROME_FILE {
        return fail(
            file,
            format!("file too large ({} bytes)", meta.len()),
            false,
        );
    }
    let text = match fs::read(file) {
        Ok(t) => t,
        // 調べた後に消えた
        Err(e) if e.kind() == ErrorKind::NotFound => return ChromeLoad::default(),
        Err(e) => return io_fail(file, &e),
    };
    let root = match serde_json::from_slice::<serde_json::Value>(&text) {
        Ok(r) => r,
        Err(e) => return fail(file, format!("invalid JSON: {e}"), false),
    };
    let mut count = 0;
    let mut roots = Vec::new();
    for key in ["bookmark_bar", "other", "synced"] {
        if let Some(n) = root.get("roots").and_then(|r| r.get(key)) {
            roots.extend(walk_chrome(n, 0, &mut count));
        }
    }
    ChromeLoad {
        roots,
        problem: None,
    }
}

/// Chrome のブックマーク（読むだけ。開くたびに読み直す）。
#[tauri::command(async)]
pub fn browser_chrome_bookmarks_load(webview: Webview) -> Result<ChromeLoad, String> {
    from_main(&webview)?;
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Ok(ChromeLoad::default());
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
        assert_eq!(load_chrome(&p), ChromeLoad::default());
        fs::write(&p, "{").unwrap();
        let broken = load_chrome(&p);
        assert!(broken.roots.is_empty());
        let problem = broken.problem.unwrap();
        assert_eq!(problem.path, p.display().to_string());
        assert!(problem.reason.starts_with("invalid JSON"));
        assert!(!problem.needs_permission);
        let body = r#"{"roots":{
          "bookmark_bar":{"type":"folder","name":"Bookmarks bar","children":[
            {"type":"url","name":"A","url":"https://a.example/"},
            {"type":"folder","name":"Dev","children":[
              {"type":"url","name":"B","url":"https://b.example/"},
              {"type":"url","name":"js","url":"javascript:alert(1)"},
              {"type":"url","name":"長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長","url":"https://long.example/"}
            ]}
          ]},
          "other":{"type":"folder","name":"Other bookmarks","children":[
            {"type":"url","name":"C","url":"http://localhost:3000/"}
          ]}
        }}"#;
        fs::write(&p, body).unwrap();
        let loaded = load_chrome(&p);
        assert_eq!(loaded.problem, None);
        let url = |u: &str, t: &str| ChromeNode::Url {
            url: u.into(),
            title: t.into(),
        };
        let ChromeNode::Folder { name, children } = &loaded.roots[0] else {
            panic!()
        };
        assert_eq!(name, "Bookmarks bar");
        // 開けない URL のものは捨て、フォルダの入れ子と並びは Chrome のまま
        assert_eq!(children[0], url("https://a.example/", "A"));
        let ChromeNode::Folder { name, children } = &children[1] else {
            panic!()
        };
        assert_eq!(name, "Dev");
        assert_eq!(children.len(), 2);
        assert_eq!(children[0], url("https://b.example/", "B"));
        // 題が長すぎるものは、URL が正しければ題を切って残す
        let ChromeNode::Url { url: u, title } = &children[1] else {
            panic!()
        };
        assert_eq!(u, "https://long.example/");
        assert!(!title.is_empty() && title.len() <= MAX_TITLE);
        assert_eq!(
            loaded.roots[1],
            ChromeNode::Folder {
                name: "Other bookmarks".into(),
                children: vec![url("http://localhost:3000/", "C")],
            }
        );
        assert_eq!(loaded.roots.len(), 2);
        assert_eq!(fs::read_to_string(&p).unwrap(), body);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn chrome_problems_carry_the_path_and_reason_but_a_missing_file_does_not() {
        let d = temp_dir("chrome-problem");
        fs::create_dir_all(&d).unwrap();
        // ファイルでないもの
        let dir_as_file = d.join("Bookmarks");
        fs::create_dir_all(&dir_as_file).unwrap();
        let got = load_chrome(&dir_as_file);
        assert_eq!(got.problem.unwrap().reason, "not a regular file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // 権限が無い（root は権限を無視するので、読めないときだけ確かめる）
            let p = d.join("locked");
            fs::write(&p, "{}").unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(0o000)).unwrap();
            if fs::read(&p).is_err() {
                let problem = load_chrome(&p).problem.unwrap();
                assert_eq!(problem.path, p.display().to_string());
                assert!(problem.reason.contains("Permission denied"));
                assert_eq!(problem.needs_permission, cfg!(target_os = "macos"));
            }
            // 入れ物のフォルダを開けない
            let sub = d.join("sub");
            fs::create_dir_all(&sub).unwrap();
            fs::write(sub.join("Bookmarks"), "{}").unwrap();
            fs::set_permissions(&sub, fs::Permissions::from_mode(0o000)).unwrap();
            if fs::metadata(sub.join("Bookmarks")).is_err() {
                assert!(load_chrome(&sub.join("Bookmarks")).problem.is_some());
            }
            fs::set_permissions(&sub, fs::Permissions::from_mode(0o755)).unwrap();
        }
        // 大きすぎる
        let big = d.join("big");
        fs::File::create(&big)
            .unwrap()
            .set_len(MAX_CHROME_FILE + 1)
            .unwrap();
        assert!(load_chrome(&big)
            .problem
            .unwrap()
            .reason
            .starts_with("file too large"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn chrome_file_is_under_the_profile() {
        let p = chrome_file(Path::new("/h"), "Default");
        assert!(p.ends_with("Default/Bookmarks"));
        assert!(p.starts_with("/h"));
    }
}
