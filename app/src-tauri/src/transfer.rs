//! ターミナルのファイル転送（kitty の file transfer protocol、OSC 5113）の、手元のファイルを読み書きする側。
//!
//! 何を許すかは画面が決める（ユーザーに聞く）。ここは「聞いたあとにだけ、許した範囲だけ」を守る。
//! ssh 先のプログラムがパスを決められるので、ここで次を守る（kitty の file transfer のパスと TOCTOU の脆弱性への備え）。
//!
//! - 書くのは、画面が聞いた 1 つのディレクトリ（`~/Downloads`）の中だけ。頼まれた名前の `..`・絶対パス・`~/` は
//!   そのディレクトリの中の相対パスに直し、`..` は断る。ディレクトリの下り方は、ディレクトリの fd から
//!   `openat(O_NOFOLLOW | O_DIRECTORY)` で 1 段ずつ行う。途中がシンボリックリンクに差し替えられても辿らない
//!   （パスの文字列を検査してから開く形にしない）。ファイルは `O_CREAT | O_EXCL | O_NOFOLLOW` で新しく作り、
//!   すでにあるファイルは上書きしない。シンボリックリンクとハードリンクは作らない（画面側で断る）。
//! - 読むのは、画面がユーザーに見せて許した一覧の中のファイルだけ。一覧はここで作り（`lstat` で、
//!   シンボリックリンクは辿らない）、許す前は読めない。開くときは `O_NOFOLLOW` で、普通のファイルかを開いた fd で確かめる。
//!
//! データは Tauri の IPC の生のバイト列で受け渡す（base64 にしない）。セッションの鍵は画面側が欄ごとに決める。

use std::collections::HashMap;
use std::ffi::{CString, OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

/// 同時に持つセッションの数の上限。
const MAX_SESSIONS: usize = 64;
/// 1 つのセッションで書く・並べるファイルの数の上限。
const MAX_FILES: usize = 10_000;
/// ディレクトリの深さの上限（書くときの相対パス、読む一覧の入れ子）。
const MAX_DEPTH: usize = 64;
/// 1 回の読みの大きさの上限。
const MAX_READ: usize = 1 << 20;

/// 転送の状態。`tauri::Builder::manage` で持つ。
#[derive(Default)]
pub struct Transfers {
    sessions: Mutex<HashMap<String, Session>>,
}

enum Session {
    Write(WriteSession),
    Read(ReadSession),
}

struct WriteSession {
    root: File,
    files: HashMap<String, WriteFile>,
    /// 作ったファイルの相対パス（取り消しで消す）。
    created: Vec<(Vec<OsString>, bool)>,
}

struct WriteFile {
    file: File,
    rel: Vec<OsString>,
    perms: Option<u32>,
    mtime: Option<SystemTime>,
    written: u64,
    limit: u64,
    done: bool,
}

struct ReadSession {
    entries: HashMap<String, ReadEntry>,
    approved: bool,
    open: HashMap<String, File>,
}

struct ReadEntry {
    path: PathBuf,
    regular: bool,
}

type R<T> = Result<T, String>;

/// `ENOENT:理由` の形のエラー（画面が前の部分を記号名として答えに使う）。
fn err(e: &io::Error) -> String {
    use io::ErrorKind::*;
    let code = match e.raw_os_error() {
        Some(libc::ENOTDIR) => "ENOTDIR",
        Some(libc::EISDIR) => "EISDIR",
        Some(libc::ENOSPC) => "ENOSPC",
        Some(libc::EFBIG) => "EFBIG",
        // O_NOFOLLOW でシンボリックリンクに当たった
        Some(libc::ELOOP) => "EPERM",
        _ => match e.kind() {
            NotFound => "ENOENT",
            AlreadyExists => "EEXIST",
            PermissionDenied => "EACCES",
            InvalidInput | InvalidData => "EINVAL",
            _ => "EIO",
        },
    };
    format!("{code}:{e}")
}

fn coded(code: &str, msg: &str) -> String {
    format!("{code}:{msg}")
}

fn home() -> R<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|h| h.is_absolute())
        .ok_or_else(|| coded("ENOENT", "no home directory"))
}

/// 書き込み先のディレクトリ（`~/Downloads`）。シンボリックリンクは解いた先を返す。
fn dest_dir() -> R<PathBuf> {
    let p = home()?.join("Downloads");
    let c = fs::canonicalize(&p).map_err(|e| err(&e))?;
    if !c.is_dir() {
        return Err(coded("ENOTDIR", "Downloads is not a directory"));
    }
    Ok(c)
}

/// 頼まれた名前を、書き込み先の中の相対パス（部品の列）にする。`~/` と手元のホームの接頭辞と先頭の `/` を外し、
/// `.` と空の部品は捨て、`..`・NUL・長すぎる部品・深すぎるパスは断る。
fn clean_rel(name: &str, home: &Path) -> R<Vec<OsString>> {
    if name.contains('\0') {
        return Err(coded("EINVAL", "invalid name"));
    }
    let mut s = name;
    if let Some(r) = s.strip_prefix("~/") {
        s = r;
    } else if let Some(h) = home.to_str() {
        if let Some(r) = s.strip_prefix(h).and_then(|r| r.strip_prefix('/')) {
            s = r;
        }
    }
    let mut out = Vec::new();
    for part in s.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(coded("EPERM", "parent directory in the name")),
            p if p.len() > 255 => return Err(coded("EINVAL", "name too long")),
            p => out.push(OsString::from(p)),
        }
    }
    if out.is_empty() || out.len() > MAX_DEPTH {
        return Err(coded("EINVAL", "invalid name"));
    }
    Ok(out)
}

fn cstr(s: &OsStr) -> io::Result<CString> {
    CString::new(s.as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

fn from_fd(fd: libc::c_int) -> io::Result<File> {
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: openat が返した、自分だけが持つ fd
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

/// `dir` の下の `name` のディレクトリを開く。シンボリックリンクは辿らない。`create` なら無ければ作る。
fn open_dir_at(dir: &File, name: &OsStr, create: bool) -> io::Result<File> {
    let c = cstr(name)?;
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: c は NUL 終端、dir は開いている fd
    let fd = unsafe { libc::openat(dir.as_raw_fd(), c.as_ptr(), flags) };
    if fd >= 0 {
        return from_fd(fd);
    }
    let e = io::Error::last_os_error();
    if create && e.raw_os_error() == Some(libc::ENOENT) {
        // SAFETY: 同上
        if unsafe { libc::mkdirat(dir.as_raw_fd(), c.as_ptr(), 0o755) } < 0 {
            let e = io::Error::last_os_error();
            if e.raw_os_error() != Some(libc::EEXIST) {
                return Err(e);
            }
        }
        // SAFETY: 同上
        return from_fd(unsafe { libc::openat(dir.as_raw_fd(), c.as_ptr(), flags) });
    }
    Err(e)
}

/// 途中のディレクトリを 1 段ずつ（シンボリックリンクを辿らずに）下りた先。
fn walk(root: &File, parents: &[OsString], create: bool) -> io::Result<File> {
    let mut cur = root.try_clone()?;
    for p in parents {
        cur = open_dir_at(&cur, p, create)?;
    }
    Ok(cur)
}

fn unlink_at(dir: &File, name: &OsStr, is_dir: bool) {
    if let Ok(c) = cstr(name) {
        let flag = if is_dir { libc::AT_REMOVEDIR } else { 0 };
        // SAFETY: c は NUL 終端、dir は開いている fd
        unsafe { libc::unlinkat(dir.as_raw_fd(), c.as_ptr(), flag) };
    }
}

fn insert(map: &mut HashMap<String, Session>, key: String, s: Session) -> R<()> {
    if map.len() >= MAX_SESSIONS && !map.contains_key(&key) {
        return Err(coded("EIO", "too many transfers"));
    }
    map.insert(key, s);
    Ok(())
}

// ---- 書く（リモート → 手元） ----

/// 書き込み先のディレクトリ（ユーザーに見せる）。
#[tauri::command]
pub fn transfer_dest() -> R<String> {
    dest_dir().map(|p| p.to_string_lossy().into_owned())
}

/// ユーザーが許したあとに呼ぶ。書き込み先を開いて、このセッションの書き込みを始める。書き込み先のパスを返す。
#[tauri::command]
pub fn transfer_write_begin(state: State<Transfers>, key: String) -> R<String> {
    let dir = dest_dir()?;
    let root = File::open(&dir).map_err(|e| err(&e))?;
    let mut map = state.sessions.lock().unwrap();
    insert(
        &mut map,
        key,
        Session::Write(WriteSession {
            root,
            files: HashMap::new(),
            created: Vec::new(),
        }),
    )?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 画面（transferOs.ts の writeOpen）から受ける、書くファイルかディレクトリ 1 つの頼み。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOpen {
    file_id: String,
    name: String,
    directory: bool,
    permissions: Option<u32>,
    /// 更新時刻（ナノ秒、10 進の文字列）。
    mtime: Option<String>,
    /// 書いてよい大きさの上限（バイト）。
    limit: u64,
}

/// ファイルかディレクトリを作る。ファイルは書き終えるまで `transfer_write_end` で閉じない。作った相対パスを返す。
#[tauri::command]
pub fn transfer_write_open(state: State<Transfers>, key: String, open: WriteOpen) -> R<String> {
    let mut map = state.sessions.lock().unwrap();
    let Some(Session::Write(w)) = map.get_mut(&key) else {
        return Err(coded("EPERM", "no write session"));
    };
    if w.created.len() >= MAX_FILES {
        return Err(coded("EFBIG", "too many files"));
    }
    let rel = clean_rel(&open.name, &home()?)?;
    let (leaf, parents) = rel
        .split_last()
        .expect("clean_rel returns a non-empty path");
    let shown = rel
        .iter()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned();
    if open.directory {
        let parent = walk(&w.root, parents, true).map_err(|e| err(&e))?;
        open_dir_at(&parent, leaf, true).map_err(|e| err(&e))?;
        return Ok(shown);
    }
    if w.files.contains_key(&open.file_id) {
        return Err(coded("EINVAL", "duplicate file id"));
    }
    let parent = walk(&w.root, parents, true).map_err(|e| err(&e))?;
    let c = cstr(leaf).map_err(|e| err(&e))?;
    let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: c は NUL 終端、parent は開いている fd
    let file = from_fd(unsafe { libc::openat(parent.as_raw_fd(), c.as_ptr(), flags, 0o600) })
        .map_err(|e| err(&e))?;
    let mtime = open
        .mtime
        .and_then(|s| s.parse::<u64>().ok())
        .map(|ns| UNIX_EPOCH + Duration::from_nanos(ns));
    w.created.push((rel.clone(), false));
    w.files.insert(
        open.file_id,
        WriteFile {
            file,
            rel,
            perms: open.permissions,
            mtime,
            written: 0,
            limit: open.limit,
            done: false,
        },
    );
    Ok(shown)
}

/// データを書く。本体が書くデータ（生のバイト列）、ヘッダ `x-key`・`x-file` がセッションとファイル。ここまでに書いた大きさを返す。
#[tauri::command]
pub fn transfer_write_chunk(state: State<Transfers>, request: Request<'_>) -> R<u64> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err(coded("EINVAL", "raw body expected"));
    };
    let header = |n: &str| {
        request
            .headers()
            .get(n)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| coded("EINVAL", "missing header"))
    };
    let (key, fid) = (header("x-key")?, header("x-file")?);
    let mut map = state.sessions.lock().unwrap();
    let Some(Session::Write(w)) = map.get_mut(&key) else {
        return Err(coded("EPERM", "no write session"));
    };
    let f = w
        .files
        .get_mut(&fid)
        .filter(|f| !f.done)
        .ok_or_else(|| coded("EINVAL", "unknown file"))?;
    if f.written + data.len() as u64 > f.limit {
        return Err(coded("EFBIG", "more data than announced"));
    }
    f.file.write_all(data).map_err(|e| err(&e))?;
    f.written += data.len() as u64;
    Ok(f.written)
}

/// ファイルを書き終える。権限（所有者の読み書きは必ず付ける。setuid などは付けない）と更新時刻を直し、書いた大きさを返す。
#[tauri::command]
pub fn transfer_write_end(state: State<Transfers>, key: String, file_id: String) -> R<u64> {
    let mut map = state.sessions.lock().unwrap();
    let Some(Session::Write(w)) = map.get_mut(&key) else {
        return Err(coded("EPERM", "no write session"));
    };
    let f = w
        .files
        .get_mut(&file_id)
        .filter(|f| !f.done)
        .ok_or_else(|| coded("EINVAL", "unknown file"))?;
    f.file.flush().map_err(|e| err(&e))?;
    if let Some(p) = f.perms {
        f.file
            .set_permissions(fs::Permissions::from_mode((p & 0o777) | 0o600))
            .map_err(|e| err(&e))?;
    }
    if let Some(t) = f.mtime {
        f.file.set_modified(t).map_err(|e| err(&e))?;
    }
    f.done = true;
    let rel = f.rel.clone();
    let n = f.written;
    if let Some(c) = w.created.iter_mut().find(|(r, _)| *r == rel) {
        c.1 = true;
    }
    Ok(n)
}

/// 書き込みのセッションを閉じる。`keep_done` が真なら、書き終えたファイルは残し、途中のものだけ消す。
/// 偽（取り消し・断り）なら、このセッションで作ったファイルを全部消す。
#[tauri::command]
pub fn transfer_write_close(state: State<Transfers>, key: String, keep_done: bool) {
    let mut map = state.sessions.lock().unwrap();
    if let Some(Session::Write(mut w)) = map.remove(&key) {
        let created = std::mem::take(&mut w.created);
        w.files.clear();
        for (rel, done) in created.into_iter().rev() {
            if keep_done && done {
                continue;
            }
            let (leaf, parents) = rel.split_last().expect("non-empty");
            if let Ok(dir) = walk(&w.root, parents, false) {
                unlink_at(&dir, leaf, false);
            }
        }
    }
}

// ---- 読む（手元 → リモート） ----

/// 画面（transferOs.ts の readList）から受ける、相手が読みたいと頼んだパス 1 つ。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadRequest {
    file_id: String,
    name: String,
}

/// 並べた項目 1 つ。画面（transfer.ts の ListEntry）が窓に見せ、許されたら相手への一覧にする。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    request_id: String,
    entry_id: String,
    name: String,
    file_type: &'static str,
    mtime: Option<String>,
    permissions: Option<u32>,
    size: Option<u64>,
    parent: Option<String>,
    /// シンボリックリンクの先。
    data: Option<String>,
}

/// 並べられなかった頼み 1 つ（画面は許可のあとにだけ、記号名を相手に返す）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListError {
    request_id: String,
    code: String,
    message: String,
}

/// `transfer_read_list` の結果。画面（transfer.ts の Listing）に渡す。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    entries: Vec<ListEntry>,
    errors: Vec<ListError>,
    home: String,
    /// 普通のファイルの大きさの合計。
    total_size: u64,
}

fn resolve_read(name: &str, home: &Path) -> R<PathBuf> {
    if name.contains('\0') || name.is_empty() {
        return Err(coded("EINVAL", "invalid name"));
    }
    let p = if name == "~" {
        home.to_path_buf()
    } else if let Some(r) = name.strip_prefix("~/") {
        home.join(r)
    } else if name.starts_with('/') {
        PathBuf::from(name)
    } else {
        home.join(name)
    };
    // `..` を含むパスは、読む場所を読み手が読み違えるので断る
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(coded("EINVAL", "parent directory in the name"));
    }
    Ok(p)
}

fn meta_entry(
    meta: &fs::Metadata,
    path: &Path,
    request_id: &str,
    entry_id: String,
    parent: Option<String>,
) -> ListEntry {
    let ft = meta.file_type();
    let (file_type, data) = if ft.is_symlink() {
        (
            "symlink",
            fs::read_link(path)
                .ok()
                .map(|t| t.to_string_lossy().into_owned()),
        )
    } else if ft.is_dir() {
        ("directory", None)
    } else {
        ("regular", None)
    };
    ListEntry {
        request_id: request_id.to_owned(),
        entry_id,
        name: path.to_string_lossy().into_owned(),
        file_type,
        mtime: (meta.mtime() >= 0).then(|| {
            (meta.mtime() as i128 * 1_000_000_000 + meta.mtime_nsec() as i128).to_string()
        }),
        permissions: Some(meta.mode() & 0o7777),
        size: ft.is_file().then(|| meta.len()),
        parent,
        data,
    }
}

struct Lister<'a> {
    request_id: &'a str,
    next: usize,
    entries: Vec<ListEntry>,
    index: &'a mut HashMap<String, ReadEntry>,
    total: u64,
}

impl Lister<'_> {
    fn add(&mut self, path: &Path, parent: Option<String>, depth: usize) -> R<()> {
        if self.entries.len() >= MAX_FILES || depth > MAX_DEPTH {
            return Err(coded("EFBIG", "too many files"));
        }
        let meta = fs::symlink_metadata(path).map_err(|e| err(&e))?;
        let ft = meta.file_type();
        if !(ft.is_file() || ft.is_dir() || ft.is_symlink()) {
            // 名前付きパイプなどは送らない
            return Err(coded("EINVAL", "not a regular file"));
        }
        self.next += 1;
        let id = format!("e{}", self.next);
        self.entries
            .push(meta_entry(&meta, path, self.request_id, id.clone(), parent));
        self.index.insert(
            id.clone(),
            ReadEntry {
                path: path.to_path_buf(),
                regular: ft.is_file(),
            },
        );
        if ft.is_file() {
            self.total += meta.len();
        }
        if ft.is_dir() {
            let mut kids: Vec<_> = fs::read_dir(path)
                .map_err(|e| err(&e))?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .collect();
            kids.sort();
            for k in kids {
                // 子の読めないものは飛ばす
                let _ = self.add(&k, Some(id.clone()), depth + 1);
            }
        }
        Ok(())
    }
}

/// 頼まれたパスを（ディレクトリは中まで）並べる。まだ読めない。ユーザーが許したあとに `transfer_read_approve` を呼ぶ。
#[tauri::command]
pub fn transfer_read_list(
    state: State<Transfers>,
    key: String,
    requests: Vec<ReadRequest>,
) -> R<Listing> {
    let home = home()?;
    let mut index = HashMap::new();
    let mut entries = Vec::new();
    let mut errors = Vec::new();
    let mut total = 0;
    let mut next = 0;
    for rq in requests {
        let mut l = Lister {
            request_id: &rq.file_id,
            next,
            entries: Vec::new(),
            index: &mut index,
            total: 0,
        };
        match resolve_read(&rq.name, &home).and_then(|p| l.add(&p, None, 0)) {
            Ok(()) => {}
            Err(e) => {
                let (code, message) = e.split_once(':').unwrap_or(("EIO", &e));
                errors.push(ListError {
                    request_id: rq.file_id.clone(),
                    code: code.to_owned(),
                    message: message.to_owned(),
                });
            }
        }
        next = l.next;
        total += l.total;
        entries.append(&mut l.entries);
    }
    let mut map = state.sessions.lock().unwrap();
    insert(
        &mut map,
        key,
        Session::Read(ReadSession {
            entries: index,
            approved: false,
            open: HashMap::new(),
        }),
    )?;
    Ok(Listing {
        entries,
        errors,
        home: home.to_string_lossy().into_owned(),
        total_size: total,
    })
}

/// ユーザーが許したあとに呼ぶ。これ以後、並べたファイルだけ読める。
#[tauri::command]
pub fn transfer_read_approve(state: State<Transfers>, key: String) -> R<()> {
    let mut map = state.sessions.lock().unwrap();
    match map.get_mut(&key) {
        Some(Session::Read(r)) => {
            r.approved = true;
            Ok(())
        }
        _ => Err(coded("EPERM", "no read session")),
    }
}

/// 並べたファイルの 1 つを開く（`entry_id` は並べたときのもの）。開いた fd が普通のファイルかを確かめる。大きさを返す。
#[tauri::command]
pub fn transfer_read_open(state: State<Transfers>, key: String, entry_id: String) -> R<u64> {
    let mut map = state.sessions.lock().unwrap();
    let Some(Session::Read(r)) = map.get_mut(&key) else {
        return Err(coded("EPERM", "no read session"));
    };
    if !r.approved {
        return Err(coded("EPERM", "not approved"));
    }
    let e = r
        .entries
        .get(&entry_id)
        .filter(|e| e.regular)
        .ok_or_else(|| coded("EPERM", "not in the approved list"))?;
    let c = cstr(e.path.as_os_str()).map_err(|e| err(&e))?;
    let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
    // SAFETY: c は NUL 終端
    let f = from_fd(unsafe { libc::open(c.as_ptr(), flags) }).map_err(|e| err(&e))?;
    let meta = f.metadata().map_err(|e| err(&e))?;
    if !meta.is_file() {
        return Err(coded("EPERM", "not a regular file"));
    }
    r.open.insert(entry_id, f);
    Ok(meta.len())
}

/// 開いたファイルを `len` バイトまで読む（空は終わり。終わったら閉じる）。
#[tauri::command]
pub fn transfer_read_next(
    state: State<Transfers>,
    key: String,
    entry_id: String,
    len: usize,
) -> R<Response> {
    let mut map = state.sessions.lock().unwrap();
    let Some(Session::Read(r)) = map.get_mut(&key) else {
        return Err(coded("EPERM", "no read session"));
    };
    let f = r
        .open
        .get_mut(&entry_id)
        .ok_or_else(|| coded("EINVAL", "not opened"))?;
    let mut buf = vec![0u8; len.clamp(1, MAX_READ)];
    let n = f.read(&mut buf).map_err(|e| err(&e))?;
    buf.truncate(n);
    if n == 0 {
        r.open.remove(&entry_id);
    }
    Ok(Response::new(buf))
}

/// 読みのセッションを閉じる。
#[tauri::command]
pub fn transfer_read_close(state: State<Transfers>, key: String) {
    state.sessions.lock().unwrap().remove(&key);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStringExt;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("shj-transfer-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn os(v: &[&str]) -> Vec<OsString> {
        v.iter()
            .map(|s| OsString::from_vec(s.as_bytes().to_vec()))
            .collect()
    }

    #[test]
    fn clean_rel_confines_names() {
        let h = Path::new("/home/u");
        assert_eq!(clean_rel("a/b.txt", h).unwrap(), os(&["a", "b.txt"]));
        assert_eq!(clean_rel("/etc/passwd", h).unwrap(), os(&["etc", "passwd"]));
        assert_eq!(clean_rel("~/x/./y", h).unwrap(), os(&["x", "y"]));
        assert_eq!(clean_rel("/home/u/docs/f", h).unwrap(), os(&["docs", "f"]));
        assert!(clean_rel("../x", h).is_err());
        assert!(clean_rel("a/../../x", h).is_err());
        assert!(clean_rel("", h).is_err());
        assert!(clean_rel("/", h).is_err());
        assert!(clean_rel("a\0b", h).is_err());
    }

    #[test]
    fn walk_does_not_follow_symlinks() {
        let root = tmp("walk");
        let outside = tmp("walk-outside");
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let rf = File::open(&root).unwrap();
        // 途中がシンボリックリンクなら辿らない
        assert!(walk(&rf, &os(&["link", "sub"]), true).is_err());
        assert!(!outside.join("sub").exists());
        // ふつうのディレクトリは作って下りる
        walk(&rf, &os(&["a", "b"]), true).unwrap();
        assert!(root.join("a/b").is_dir());
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn create_refuses_existing_and_symlink_leaf() {
        let root = tmp("create");
        let outside = tmp("create-outside");
        fs::write(outside.join("target"), b"keep").unwrap();
        std::os::unix::fs::symlink(outside.join("target"), root.join("l")).unwrap();
        fs::write(root.join("exists"), b"keep").unwrap();
        let rf = File::open(&root).unwrap();
        let flags =
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        for n in ["l", "exists"] {
            let c = cstr(OsStr::new(n)).unwrap();
            let fd = unsafe { libc::openat(rf.as_raw_fd(), c.as_ptr(), flags, 0o600) };
            assert!(fd < 0, "{n} must not be opened for writing");
        }
        assert_eq!(fs::read(outside.join("target")).unwrap(), b"keep");
        assert_eq!(fs::read(root.join("exists")).unwrap(), b"keep");
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn listing_does_not_follow_symlinks() {
        let root = tmp("list");
        let outside = tmp("list-outside");
        fs::write(outside.join("secret"), b"x").unwrap();
        fs::create_dir(root.join("d")).unwrap();
        fs::write(root.join("d/f"), b"abc").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("d/l")).unwrap();
        let mut index = HashMap::new();
        let mut l = Lister {
            request_id: "f1",
            next: 0,
            entries: Vec::new(),
            index: &mut index,
            total: 0,
        };
        l.add(&root.join("d"), None, 0).unwrap();
        let types: Vec<_> = l.entries.iter().map(|e| e.file_type).collect();
        assert_eq!(types, ["directory", "regular", "symlink"]);
        assert_eq!(l.total, 3);
        assert!(!l.entries.iter().any(|e| e.name.ends_with("secret")));
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }
}
