//! 内蔵ブラウザのブックマーク（#205）。すべてのワークスペースで共有し、データのフォルダの `browser-bookmarks.json` に覚える
//! （開いていたタブの `browser-tabs.json` と同じ場所。自分だけが読めるファイル）。
//! 並び・足す・消すは画面（`app/src/features/browser/bookmarks.ts`）が決め、ここは丸ごと読む・書くだけ。

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

// ---- Firefox のブックマーク（#543。#239 の Chrome のものを置き換えた）。読むだけで、Firefox のファイルには書かない ----

/// Firefox のブックマークの写し（places.sqlite と places.sqlite-wal を合わせたもの）の大きさの上限（バイト。これより大きければ読まない）。
/// places.sqlite には履歴も入るので、Chrome の Bookmarks（64 MiB）より大きくとる。
const MAX_FIREFOX_FILES: u64 = 256 * 1024 * 1024;
/// フォルダの入れ子をたどる深さの上限。
const MAX_DEPTH: usize = 32;
/// `moz_bookmarks.type` の値（Firefox の `nsINavBookmarksService` と同じ名前）。区切り線の `TYPE_SEPARATOR`（3）は読まない。
const TYPE_BOOKMARK: i64 = 1;
const TYPE_FOLDER: i64 = 2;
/// 根のフォルダの guid と、画面に渡す名前（画面が言葉にする）。この順に出す。
const FIREFOX_ROOTS: [(&str, &str); 4] = [
    ("toolbar_____", "toolbar"),
    ("menu________", "menu"),
    ("unfiled_____", "unfiled"),
    ("mobile______", "mobile"),
];

/// Firefox のブックマークの木の節。Firefox と同じ入れ子で、フォルダの中の並びも Firefox の順（`position`）のまま。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum FirefoxNode {
    Folder {
        name: String,
        /// 根のフォルダなら、どの根か（`toolbar`・`menu`・`unfiled`・`mobile`。画面がその言葉で名前を出す）
        #[serde(skip_serializing_if = "Option::is_none")]
        root: Option<&'static str>,
        children: Vec<FirefoxNode>,
    },
    Url {
        url: String,
        title: String,
    },
}

/// Firefox の `profiles.ini` があるかもしれないフォルダ（見る順）。macOS は `~/Library/Application Support/Firefox`。
/// それ以外（Linux）は `~/.mozilla/firefox` と、そこに無いときの `$XDG_CONFIG_HOME/mozilla/firefox`
/// （無ければ `~/.config/mozilla/firefox`。XDG の場所に作る新しい Firefox の版のため）。
fn firefox_dirs(home: &Path, xdg_config: Option<&Path>) -> Vec<PathBuf> {
    if cfg!(target_os = "macos") {
        return vec![home.join("Library/Application Support/Firefox")];
    }
    let xdg = xdg_config
        .filter(|p| p.is_absolute())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".config"));
    vec![home.join(".mozilla/firefox"), xdg.join("mozilla/firefox")]
}

/// `profiles.ini` の中身から、Firefox が普段開くプロファイルのフォルダを選ぶ（`dir` は `profiles.ini` のあるフォルダ）。
/// `[Install…]` 節の `Default` を先に見る（節が複数あれば最初のもの）。無ければ `[Profile…]` 節のうち `Default=1` のもの。
/// どちらも無ければ None。
fn default_profile(dir: &Path, ini: &str) -> Option<PathBuf> {
    // 節ごとの (名前, 項目) の並び
    let mut sections: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for line in ini.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            sections.push((name.trim().to_string(), Vec::new()));
        } else if let (Some((k, v)), Some((_, entries))) =
            (line.split_once('='), sections.last_mut())
        {
            entries.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let get = |entries: &[(String, String)], key: &str| {
        entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    };
    // 相対の道（IsRelative=1 のプロファイルと、Install の Default のふつうの書き方）は profiles.ini のあるフォルダから。
    // 絶対の道（IsRelative=0）は、join がそのまま返す
    let resolve = |p: &str| dir.join(p);
    let install = sections
        .iter()
        .filter(|(name, _)| name.starts_with("Install"))
        .find_map(|(_, e)| get(e, "Default").filter(|v| !v.is_empty()));
    if let Some(p) = install {
        return Some(resolve(&p));
    }
    sections
        .iter()
        .filter(|(name, e)| {
            name.starts_with("Profile") && get(e, "Default").as_deref() == Some("1")
        })
        .find_map(|(_, e)| {
            get(e, "Path")
                .filter(|v| !v.is_empty())
                .map(|p| resolve(&p))
        })
}

/// Firefox のブックマークを読めなかった理由（#265）。Firefox が入っていない（`profiles.ini` や `places.sqlite` が無い）のは
/// 理由にしない（Notice を出さない）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirefoxProblem {
    /// 読もうとしたファイル
    pub path: String,
    /// 理由（OS や SQLite のエラーの文、または大きすぎるなどの短い文）
    pub reason: String,
    /// macOS で権限が無いための失敗か（画面が、フルディスクアクセスの案内を添える）
    pub needs_permission: bool,
}

/// Firefox のブックマークを読んだ結果。roots は根のフォルダ（ブックマークツールバー、ブックマークメニュー、他のブックマーク、
/// モバイルのブックマークの順。中身の無い根は入れない）。読めなかったときは roots が空で、problem に理由が入る。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct FirefoxLoad {
    pub roots: Vec<FirefoxNode>,
    pub problem: Option<FirefoxProblem>,
}

fn fail(file: &Path, reason: String, needs_permission: bool) -> FirefoxLoad {
    FirefoxLoad {
        roots: Vec::new(),
        problem: Some(FirefoxProblem {
            path: file.display().to_string(),
            reason,
            needs_permission,
        }),
    }
}

/// ファイルを読めなかった（OS のエラー）。macOS で権限が無いときは、画面が許可の案内を添える。
fn io_fail(file: &Path, e: &std::io::Error) -> FirefoxLoad {
    fail(
        file,
        e.to_string(),
        cfg!(target_os = "macos") && e.kind() == ErrorKind::PermissionDenied,
    )
}

/// 写しを置く、自分だけが読める一時フォルダ。落とすと中身ごと消す。
struct TempCopy(PathBuf);

impl TempCopy {
    fn new() -> std::io::Result<Self> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "kisui-firefox-bookmarks-{}-{}-{nanos}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        // すでにあれば（ほかの誰かが置いたものでも）使わずに失敗する
        let mut b = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        b.create(&dir)?;
        Ok(Self(dir))
    }
}

impl Drop for TempCopy {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// from を to に写す（to は新しく作る、自分だけが読めるファイル）。写した大きさを返す。limit を超えたら Ok(None)。
fn copy_limited(from: &Path, to: &Path, limit: u64) -> std::io::Result<Option<u64>> {
    use std::io::Read;
    let src = fs::File::open(from)?;
    let mut dst = crate::clipboard_history::open_private(to)?;
    let n = std::io::copy(&mut src.take(limit + 1), &mut dst)?;
    Ok((n <= limit).then_some(n))
}

/// places.sqlite の 1 行（ブックマークかフォルダ）。
struct PlacesRow {
    id: i64,
    kind: i64,
    title: String,
    url: Option<String>,
}

/// 題を、覚えるファイルの上限で字の境目で切る（覚えるファイルには入らないが、自身のものと揃える）。
fn clip_title(mut title: String) -> String {
    if title.len() > MAX_TITLE {
        let mut end = MAX_TITLE;
        while !title.is_char_boundary(end) {
            end -= 1;
        }
        title.truncate(end);
    }
    title
}

/// フォルダ id の中身を木にする。数えるのは、残したブックマーク（count。MAX_BOOKMARKS まで）。
/// 開けない URL のものと、深すぎるフォルダの先は捨てる。
fn walk_firefox(
    children: &std::collections::HashMap<i64, Vec<PlacesRow>>,
    id: i64,
    depth: usize,
    count: &mut usize,
) -> Vec<FirefoxNode> {
    let mut out = Vec::new();
    if depth > MAX_DEPTH {
        return out;
    }
    for row in children.get(&id).map(Vec::as_slice).unwrap_or_default() {
        if *count >= MAX_BOOKMARKS {
            break;
        }
        match row.kind {
            TYPE_BOOKMARK => {
                let b = Bookmark {
                    url: row.url.clone().unwrap_or_default(),
                    title: clip_title(row.title.clone()),
                };
                if valid(&b) {
                    *count += 1;
                    out.push(FirefoxNode::Url {
                        url: b.url,
                        title: b.title,
                    });
                }
            }
            TYPE_FOLDER => out.push(FirefoxNode::Folder {
                name: row.title.clone(),
                root: None,
                children: walk_firefox(children, row.id, depth + 1, count),
            }),
            _ => {}
        }
    }
    out
}

/// 写した places.sqlite（読み取り専用で開く）から、根のフォルダの木を読む。
fn read_places_copy(db: &Path) -> rusqlite::Result<Vec<FirefoxNode>> {
    use rusqlite::{Connection, OpenFlags};
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let mut root_ids = Vec::new();
    for (guid, key) in FIREFOX_ROOTS {
        let found = conn.query_row(
            "SELECT id, title FROM moz_bookmarks WHERE guid = ?1 AND type = ?2",
            rusqlite::params![guid, TYPE_FOLDER],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)),
        );
        match found {
            Ok((id, title)) => root_ids.push((id, key, title.unwrap_or_default())),
            Err(rusqlite::Error::QueryReturnedNoRows) => {}
            Err(e) => return Err(e),
        }
    }
    // ブックマークとフォルダだけを読む（区切り線は読まない）。並びはフォルダごとに position の順
    let mut stmt = conn.prepare(
        "SELECT b.id, b.parent, b.type, b.title, p.url
         FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk
         WHERE b.type IN (?1, ?2)
         ORDER BY b.parent, b.position, b.id",
    )?;
    let mut children: std::collections::HashMap<i64, Vec<PlacesRow>> = Default::default();
    let rows = stmt.query_map([TYPE_BOOKMARK, TYPE_FOLDER], |r| {
        Ok((
            r.get::<_, i64>(1)?,
            PlacesRow {
                id: r.get(0)?,
                kind: r.get(2)?,
                title: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                url: r.get(4)?,
            },
        ))
    })?;
    for row in rows {
        let (parent, row) = row?;
        children.entry(parent).or_default().push(row);
    }
    let mut count = 0;
    Ok(root_ids
        .into_iter()
        .filter_map(|(id, key, title)| {
            let kids = walk_firefox(&children, id, 1, &mut count);
            // 中身の無い根は出さない
            (!kids.is_empty()).then_some(FirefoxNode::Folder {
                name: title,
                root: Some(key),
                children: kids,
            })
        })
        .collect())
}

/// プロファイルの places.sqlite を読む。Firefox が動いている間は排他で開かれているので、places.sqlite と（あれば）
/// places.sqlite-wal を自分だけが読める一時フォルダに写し、写しを読み取り専用で開いて読み、読み終えたら消す。
/// ファイルが無いときは空で理由も無し。大きすぎる・読めない・壊れているときは、空と理由。
/// 2 つのファイルは別々に写すので、その間に Firefox が書き戻し（checkpoint）て WAL を書き直すと、写しの組が食い違って
/// 読めないことがある。写しを読めなかったときは、1 度だけ写し直して読む。
fn load_places(places: &Path) -> FirefoxLoad {
    match copy_and_read_places(places) {
        Ok(load) => load,
        Err(_) => copy_and_read_places(places).unwrap_or_else(|load| load),
    }
}

/// places.sqlite を 1 度写して読む。写しを SQLite で読めなかったときだけ Err（写し直せば読めるかもしれない）。
fn copy_and_read_places(places: &Path) -> Result<FirefoxLoad, FirefoxLoad> {
    let meta = match fs::metadata(places) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(FirefoxLoad::default()),
        Err(e) => return Ok(io_fail(places, &e)),
    };
    if !meta.is_file() {
        return Ok(fail(places, "not a regular file".into(), false));
    }
    let mut wal = places.as_os_str().to_owned();
    wal.push("-wal");
    let wal = PathBuf::from(wal);
    let wal_len = match fs::metadata(&wal) {
        Ok(m) if m.is_file() => Some(m.len()),
        Ok(_) => None,
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(e) => return Ok(io_fail(&wal, &e)),
    };
    let total = meta.len() + wal_len.unwrap_or(0);
    if total > MAX_FIREFOX_FILES {
        // 理由に大きさを入れない（Firefox が動いている間は -wal が開くたびに大きくなり、同じ理由として続けて知らせないことが効かなくなる）
        return Ok(fail(places, "file too large".into(), false));
    }
    let tmp = match TempCopy::new() {
        Ok(t) => t,
        Err(e) => {
            return Ok(fail(
                places,
                format!("cannot make a temporary folder: {e}"),
                false,
            ))
        }
    };
    let db = tmp.0.join("places.sqlite");
    let copied = match copy_limited(places, &db, MAX_FIREFOX_FILES) {
        Ok(Some(n)) => n,
        Ok(None) => return Ok(fail(places, "file too large".into(), false)),
        // 調べた後に消えた
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(FirefoxLoad::default()),
        Err(e) => return Ok(io_fail(places, &e)),
    };
    if wal_len.is_some() {
        match copy_limited(
            &wal,
            &tmp.0.join("places.sqlite-wal"),
            MAX_FIREFOX_FILES - copied,
        ) {
            Ok(Some(_)) => {}
            Ok(None) => return Ok(fail(places, "file too large".into(), false)),
            // Firefox が書き戻して消した（places.sqlite の写しだけで読める）
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => return Ok(io_fail(&wal, &e)),
        }
    }
    match read_places_copy(&db) {
        Ok(roots) => Ok(FirefoxLoad {
            roots,
            problem: None,
        }),
        Err(e) => Err(fail(places, e.to_string(), false)),
    }
}

/// Firefox のブックマークを読む。`dirs` の最初の `profiles.ini` があるフォルダで、Firefox が普段開くプロファイルの
/// places.sqlite を読む。`profiles.ini` や places.sqlite が無い・プロファイルが決まらないときは空で理由も無し
/// （Firefox が入っていない環境で、エラーにしない）。
pub fn load_firefox(dirs: &[PathBuf]) -> FirefoxLoad {
    for dir in dirs {
        let ini = dir.join("profiles.ini");
        let text = match fs::read(&ini) {
            Ok(t) => t,
            Err(e) if e.kind() == ErrorKind::NotFound => continue,
            Err(e) => return io_fail(&ini, &e),
        };
        return match default_profile(dir, &String::from_utf8_lossy(&text)) {
            Some(profile) => load_places(&profile.join("places.sqlite")),
            None => FirefoxLoad::default(),
        };
    }
    FirefoxLoad::default()
}

/// Firefox のブックマーク（読むだけ。開くたびに読み直す）。
#[tauri::command(async)]
pub fn browser_firefox_bookmarks_load(webview: Webview) -> Result<FirefoxLoad, String> {
    from_main(&webview)?;
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Ok(FirefoxLoad::default());
    };
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    Ok(load_firefox(&firefox_dirs(&home, xdg.as_deref())))
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
    fn the_default_profile_comes_from_install_then_from_profile_default() {
        let dir = Path::new("/h/ff");
        // [Install…] の Default が先（[Profile…] の Default=1 より）。節が複数あれば最初のもの
        let ini = "[Profile1]\nName=old\nIsRelative=1\nPath=Profiles/old\nDefault=1\n\n\
                   [Install4F96D1932A9F858E]\nDefault=Profiles/abc.default-release\nLocked=1\n\n\
                   [Install11111111]\nDefault=Profiles/other\n\n\
                   [Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\n\n\
                   [General]\nStartWithLastProfile=1\nVersion=2\n";
        assert_eq!(
            default_profile(dir, ini),
            Some(dir.join("Profiles/abc.default-release"))
        );
        // [Install…] が無ければ [Profile…] の Default=1
        let ini = "[General]\nStartWithLastProfile=1\n\n\
                   [Profile0]\nName=a\nIsRelative=1\nPath=a.default\n\n\
                   [Profile1]\r\nName=b\r\nIsRelative=1\r\nPath=b.default\r\nDefault=1\r\n";
        assert_eq!(default_profile(dir, ini), Some(dir.join("b.default")));
        // 相対でない Path
        let ini = "[Profile0]\nName=a\nIsRelative=0\nPath=/data/ff/a\nDefault=1\n";
        assert_eq!(default_profile(dir, ini), Some(PathBuf::from("/data/ff/a")));
        // Install の Default が絶対の道
        let ini = "[InstallX]\nDefault=/data/ff/b\n";
        assert_eq!(default_profile(dir, ini), Some(PathBuf::from("/data/ff/b")));
        // どちらも無い
        let ini = "[General]\nVersion=2\n\n[Profile0]\nName=a\nIsRelative=1\nPath=a\n";
        assert_eq!(default_profile(dir, ini), None);
        assert_eq!(default_profile(dir, ""), None);
        // 空の Default は無いのと同じ
        let ini = "[InstallX]\nDefault=\n\n[Profile0]\nPath=c\nDefault=1\n";
        assert_eq!(default_profile(dir, ini), Some(dir.join("c")));
    }

    #[test]
    fn firefox_dirs_follow_the_os() {
        let dirs = firefox_dirs(Path::new("/h"), Some(Path::new("/x")));
        if cfg!(target_os = "macos") {
            assert_eq!(
                dirs,
                [PathBuf::from("/h/Library/Application Support/Firefox")]
            );
        } else {
            assert_eq!(
                dirs,
                [
                    PathBuf::from("/h/.mozilla/firefox"),
                    PathBuf::from("/x/mozilla/firefox")
                ]
            );
            // XDG_CONFIG_HOME が無い・相対なら ~/.config
            for xdg in [None, Some(Path::new("rel"))] {
                assert_eq!(
                    firefox_dirs(Path::new("/h"), xdg)[1],
                    PathBuf::from("/h/.config/mozilla/firefox")
                );
            }
        }
    }

    #[test]
    fn without_firefox_there_are_no_bookmarks_and_no_problem() {
        let d = temp_dir("no-firefox");
        // profiles.ini が無い
        assert_eq!(
            load_firefox(&[d.join("a"), d.join("b")]),
            FirefoxLoad::default()
        );
        // profiles.ini はあるが、普段のプロファイルが決まらない
        fs::create_dir_all(d.join("a")).unwrap();
        fs::write(d.join("a/profiles.ini"), "[General]\nVersion=2\n").unwrap();
        assert_eq!(load_firefox(&[d.join("a")]), FirefoxLoad::default());
        // プロファイルに places.sqlite が無い
        fs::write(
            d.join("a/profiles.ini"),
            "[Profile0]\nIsRelative=1\nPath=p\nDefault=1\n",
        )
        .unwrap();
        assert_eq!(load_firefox(&[d.join("a")]), FirefoxLoad::default());
        // 大きすぎる（写す前に断る）
        fs::create_dir_all(d.join("a/p")).unwrap();
        fs::File::create(d.join("a/p/places.sqlite"))
            .unwrap()
            .set_len(MAX_FIREFOX_FILES + 1)
            .unwrap();
        let problem = load_firefox(&[d.join("a")]).problem.unwrap();
        assert_eq!(problem.reason, "file too large");
        assert_eq!(
            problem.path,
            d.join("a/p/places.sqlite").display().to_string()
        );
        // ファイルでないもの
        fs::remove_file(d.join("a/p/places.sqlite")).unwrap();
        fs::create_dir_all(d.join("a/p/places.sqlite")).unwrap();
        assert_eq!(
            load_firefox(&[d.join("a")]).problem.unwrap().reason,
            "not a regular file"
        );
        let _ = fs::remove_dir_all(&d);
    }

    /// 写しの一時フォルダのうち、このプロセスのもの。
    fn leftover_copies() -> Vec<PathBuf> {
        let prefix = format!("kisui-firefox-bookmarks-{}-", std::process::id());
        fs::read_dir(std::env::temp_dir())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
            .map(|e| e.path())
            .collect()
    }

    #[test]
    fn firefox_bookmarks_are_read_while_firefox_runs_and_after_it_closes() {
        let d = temp_dir("firefox");
        let profile = d.join("Profiles/abc.default-release");
        fs::create_dir_all(&profile).unwrap();
        fs::write(
            d.join("profiles.ini"),
            "[InstallX]\nDefault=Profiles/abc.default-release\n\n\
             [Profile0]\nIsRelative=1\nPath=Profiles/other\nDefault=1\n",
        )
        .unwrap();
        let places = profile.join("places.sqlite");
        // Firefox と同じく WAL で、排他で開いたままにする（ほかからは開けない）
        let firefox = rusqlite::Connection::open(&places).unwrap();
        firefox
            .execute_batch(
                "PRAGMA locking_mode = EXCLUSIVE;
                 PRAGMA journal_mode = WAL;
                 PRAGMA wal_autocheckpoint = 0;
                 CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR);
                 CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL,
                   parent INTEGER, position INTEGER, title LONGVARCHAR, guid TEXT);
                 INSERT INTO moz_places VALUES
                   (1, 'https://a.example/'), (2, 'https://b.example/'), (3, 'javascript:alert(1)'),
                   (4, 'place:sort=8&maxResults=10'), (5, 'http://localhost:3000/'), (6, 'https://tag.example/'),
                   (7, 'https://c.example/');
                 INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, guid) VALUES
                   (1, 2, NULL, 0, 0, '', 'root________'),
                   (2, 2, NULL, 1, 0, 'menu', 'menu________'),
                   (3, 2, NULL, 1, 1, 'toolbar', 'toolbar_____'),
                   (4, 2, NULL, 1, 2, 'tags', 'tags________'),
                   (5, 2, NULL, 1, 3, 'unfiled', 'unfiled_____'),
                   (6, 2, NULL, 1, 4, 'mobile', 'mobile______'),
                   -- ツールバー: C（3 番目）・区切り線・Dev（2 番目）・A（1 番目）を、並びと違う順に入れる
                   (10, 1, 7, 3, 3, 'C', 'c'),
                   (11, 3, NULL, 3, 1, NULL, 'sep'),
                   (12, 2, NULL, 3, 2, 'Dev', 'dev'),
                   (13, 1, 1, 3, 0, 'A', 'a'),
                   (20, 1, 3, 12, 0, 'js', 'js'),
                   (21, 1, 2, 12, 1, 'B', 'b'),
                   (22, 1, 4, 12, 2, 'Most visited', 'mv'),
                   (23, 2, NULL, 12, 3, NULL, 'empty'),
                   -- タグは出さない
                   (30, 2, NULL, 4, 0, 'x', 'tagx'),
                   (31, 1, 6, 30, 0, NULL, 'tagged'),
                   -- 題の無いブックマーク
                   (40, 1, 5, 5, 0, NULL, 'local');",
            )
            .unwrap();
        let wal = profile.join("places.sqlite-wal");
        assert!(fs::metadata(&wal).unwrap().len() > 0);
        let before = (fs::read(&places).unwrap(), fs::read(&wal).unwrap());

        let loaded = load_firefox(&[d.join("missing"), d.clone()]);
        assert_eq!(loaded.problem, None);
        let url = |u: &str, t: &str| FirefoxNode::Url {
            url: u.into(),
            title: t.into(),
        };
        assert_eq!(
            loaded.roots,
            [
                FirefoxNode::Folder {
                    name: "toolbar".into(),
                    root: Some("toolbar"),
                    children: vec![
                        url("https://a.example/", "A"),
                        // 開けない URL（javascript:・place:）は捨て、空のフォルダは残す
                        FirefoxNode::Folder {
                            name: "Dev".into(),
                            root: None,
                            children: vec![
                                url("https://b.example/", "B"),
                                FirefoxNode::Folder {
                                    name: String::new(),
                                    root: None,
                                    children: vec![],
                                },
                            ],
                        },
                        url("https://c.example/", "C"),
                    ],
                },
                // 中身の無いブックマークメニューとモバイルは出さない
                FirefoxNode::Folder {
                    name: "unfiled".into(),
                    root: Some("unfiled"),
                    children: vec![url("http://localhost:3000/", "")],
                },
            ]
        );
        // Firefox のファイルは変わらず、写しは残らない
        assert_eq!(
            (fs::read(&places).unwrap(), fs::read(&wal).unwrap()),
            before
        );
        assert!(!profile.join("places.sqlite-shm").exists());
        assert_eq!(leftover_copies(), Vec::<PathBuf>::new());
        // Firefox を閉じたあと（最後の接続を閉じると書き戻して -wal を消す。ファイルの頭は WAL の形のまま）も、同じ木を読める
        drop(firefox);
        assert!(!wal.exists());
        let header = fs::read(&places).unwrap();
        assert_eq!((header[18], header[19]), (2, 2));
        let closed = load_firefox(&[d.clone()]);
        assert_eq!(closed.problem, None);
        assert_eq!(closed.roots, loaded.roots);
        assert!(!wal.exists() && !profile.join("places.sqlite-shm").exists());
        assert_eq!(leftover_copies(), Vec::<PathBuf>::new());

        // 壊れている
        fs::remove_file(&wal).ok();
        fs::remove_file(profile.join("places.sqlite-shm")).ok();
        fs::write(&places, "this is not a database").unwrap();
        let broken = load_firefox(&[d.clone()]);
        assert!(broken.roots.is_empty());
        let problem = broken.problem.unwrap();
        assert_eq!(problem.path, places.display().to_string());
        assert!(!problem.reason.is_empty());
        assert_eq!(leftover_copies(), Vec::<PathBuf>::new());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn long_titles_are_cut_at_a_char_boundary() {
        let t = clip_title("長".repeat(MAX_TITLE));
        assert!(!t.is_empty() && t.len() <= MAX_TITLE);
        assert_eq!(clip_title("A".into()), "A");
    }
}
