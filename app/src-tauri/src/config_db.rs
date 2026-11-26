//! 窓から DB の接続（`[[db.connections]]`）を足す・直す・消す（#486。Tauri のコマンド `config_db_connections`・`config_db_connection_edit`）。
//!
//! 書くのは手元の `config.local.toml` だけ（config_list.rs の共通の処理）。手元の `kisui serve` は、DB の要求のたびに設定を読み直す
//! （kisui の `config/db.go` の `LoadDB`）ので、書いたら止めずに次の一覧から効く。リモートのマシンの接続は、そのマシンの設定ファイルに書く
//! （窓の殻が書けるのは、窓の動く PC のファイルだけ）。
//!
//! - **窓で入れられる項目**：[`FORM_KEYS`]（名前・種類・ホスト・ポート・ユーザー・データベース・読み取り専用・TLS・TLS の認証局）。
//!   環境の変種（`variants`）と権限（`human-permission`・`agent-permission`）は、設定ファイルに書く。それらを書いた項目は、窓では直さない
//!   （[`DbEntry::editable`] が false。消すことはできる）。
//! - **パスワードは書かない**：渡す形（[`DbFields`]）にパスワードの欄が無い。書き換えたあとの項目に `password` があれば、kisui と同じ理由で断る
//!   （手で書いた項目を直すとき）。パスワードは今までどおり、つなぐときに聞く（kisui serve のメモリだけ）か、キーチェーン・`~/.pgpass`・`~/.my.cnf`。
//! - **`config.toml` の接続は変えない**：同じ名前の項目を `config.local.toml` に足すと、読むときに `config.toml` の項目に代わる
//!   （項目ごとの重ね方。#483）。それは `config.toml` の接続を窓から変えることなので、断る（[`EditError::Fixed`]）。
//!   ただし、手で書いてある上書き（`config.local.toml` の、`config.toml` と同じ名前の項目）は `config.local.toml` の項目なので、窓で直す・消すことができる
//!   （断らない。[`DbEntry::overrides`] で印を付け、画面は消す確かめで「`config.toml` の接続に戻る」と言う）。
//! - **確かめ**：[`check_entry`] は kisui の `config/db.go` の `dbConnection`（変種の無い項目）と同じ間違いを、同じキーとコード（`config.err.*`）で返す。
//!   同じ結果になることは、両方のテストが同じ例（`config_db_cases.json`）で確かめる。ほかに窓だけの確かめが 2 つある：変種・権限のキー
//!   （`gui.db.fileonly`。窓では確かめられない）と、`host` に URL・`@`・接続の文字列を書くこと（`gui.db.hosturl`）と、ほかの欄に URL を書くこと（`gui.db.url`）。`user:password@host` のように資格情報を
//!   書いてしまうのを防ぐ）。間違いは書かずに返し、画面が自分の言葉で出す。
//!
//! 返す値・間違いには、入れた値（名前とキーのほか）を入れない。パスワードはもともと通らない。

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::config;
use crate::config_list::{self, Edit, EditError, DB_CONNECTIONS};

/// 窓で入れられるキー（`[[db.connections]]` の項目の）。これだけを書いた項目を、窓で直せる。
pub const FORM_KEYS: [&str; 9] = [
    "name",
    "kind",
    "host",
    "port",
    "user",
    "database",
    "read-only",
    "tls",
    "tls-ca",
];

/// kisui が知っているが、窓では入れないキー（設定ファイルに書く）。
const FILE_ONLY_KEYS: [&str; 3] = ["variants", "human-permission", "agent-permission"];

/// kisui（`config/db.go` の `dbKeys`）が知っているキー。間違いの文に並べる順。
const DB_KEYS: [&str; 12] = [
    "name",
    "kind",
    "host",
    "port",
    "user",
    "database",
    "read-only",
    "tls",
    "tls-ca",
    "human-permission",
    "agent-permission",
    "variants",
];

/// `tls` の値（kisui の `dbTLSModes` と同じ順）。
const TLS_MODES: [&str; 4] = ["prefer", "disable", "require", "verify"];

/// 名前の長さの上限（字の数。kisui の `dbNameMax`）。
const NAME_MAX: usize = 100;

/// 項目の間違い 1 つ。`key` は項目の中のキー、`code` は kisui と同じ `config.err.*`（窓だけの確かめは `gui.db.*`）、`args` は文に入れる値。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Problem {
    pub key: String,
    pub code: String,
    #[serde(default)]
    pub args: Vec<String>,
}

fn problem(key: &str, code: &str, args: &[&str]) -> Problem {
    Problem {
        key: key.into(),
        code: code.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
    }
}

/// 窓の入力欄の中身（画面の `DbConnectionFields`。app/src/features/db/connectionForm.ts）。どれも入れた字のままで、前後の空白はここで除く。
/// 空の欄は「書かない」（kisui の既定になる：ホストは localhost、ポートは種類の既定、TLS は prefer）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DbFields {
    pub name: String,
    pub kind: String,
    pub host: String,
    pub port: String,
    pub user: String,
    pub database: String,
    pub read_only: bool,
    pub tls: String,
    pub tls_ca: String,
}

impl DbFields {
    /// 書く項目と、消すキー（空の欄）。ポートが整数でなければ、その間違い。
    fn to_entry(&self) -> Result<(toml::Table, Vec<String>), Problem> {
        let mut t = toml::Table::new();
        let mut unset = Vec::new();
        let mut text = |key: &str, v: &str, skip: &str| {
            let v = v.trim();
            if v.is_empty() || v == skip {
                unset.push(key.to_string());
            } else {
                t.insert(key.into(), toml::Value::String(v.into()));
            }
        };
        text("name", &self.name, "");
        text("kind", &self.kind, "");
        text("host", &self.host, "");
        text("user", &self.user, "");
        text("database", &self.database, "");
        // prefer は書かなくても同じ（既定）
        text("tls", &self.tls, "prefer");
        text("tls-ca", &self.tls_ca, "");
        let port = self.port.trim();
        if port.is_empty() {
            unset.push("port".into());
        } else {
            let n = port
                .parse::<i64>()
                .map_err(|_| problem("port", "config.err.int", &[]))?;
            t.insert("port".into(), toml::Value::Integer(n));
        }
        if self.read_only {
            t.insert("read-only".into(), toml::Value::Boolean(true));
        } else {
            unset.push("read-only".into());
        }
        Ok((t, unset))
    }
}

/// 窓の DB の接続の書き込み 1 つ（画面の `DbConnectionEdit`）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DbEdit {
    /// 足す
    Add { connection: DbFields },
    /// 名前が `name` の項目を、`connection` にする（名前も変えられる）。窓で入れないキーは残す
    Update { name: String, connection: DbFields },
    /// 名前が `name` の項目を消す（変種も一緒に）
    Remove { name: String },
}

/// `config.local.toml` の接続 1 つ（書いてある形のまま。画面の入力欄に入れる）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbEntry {
    pub name: String,
    pub kind: String,
    pub host: String,
    pub port: String,
    pub user: String,
    pub database: String,
    pub read_only: bool,
    pub tls: String,
    pub tls_ca: String,
    /// 窓で直せるか（[`FORM_KEYS`] だけを、kisui の読む型で書いた項目）。false でも消すことはできる
    pub editable: bool,
    /// `config.toml` の同じ名前の接続に代わっている（上書き）。消すと `config.toml` の接続に戻る
    pub overrides: bool,
}

/// 窓が知る、手元の DB の接続。画面は、接続を選ぶ窓で手元のマシンの接続が直せるかを、これで決める。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct DbConnections {
    /// `config.local.toml` の項目（書いた順）
    pub local: Vec<DbEntry>,
    /// `config.toml` の項目の名前（窓では変えられない。`config.local.toml` に同じ名前があれば、そちらが代わっているので入れない）
    pub fixed: Vec<String>,
}

/// ファイル `path` の中身 `text` から、`[[db.connections]]` の項目（表）の並び。形が違えば空。
/// 読めなければ、場所だけの理由（`config::unreadable`。間違いの行の中身は、手で書いたパスワードを含むことがあるので入れない）。
fn entries_of(path: &Path, text: &str) -> Result<Vec<toml::Table>, String> {
    let doc: toml::Table = text
        .parse()
        .map_err(|e: toml::de::Error| config::unreadable(path, text, e.span()))?;
    let list = doc
        .get(DB_CONNECTIONS.table)
        .and_then(|v| v.get(DB_CONNECTIONS.name))
        .and_then(toml::Value::as_array);
    Ok(list
        .map(|a| a.iter().filter_map(|v| v.as_table().cloned()).collect())
        .unwrap_or_default())
}

/// 項目の名前（前後の空白を除く。kisui と同じ）。
fn name_of(e: &toml::Table) -> Option<String> {
    e.get("name")
        .and_then(toml::Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// `config.local.toml` の項目を、窓の入力欄の形にする。
fn entry_view(e: &toml::Table) -> DbEntry {
    let s = |k: &str| {
        e.get(k)
            .and_then(toml::Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let typed = e.iter().all(|(k, v)| match k.as_str() {
        "port" => v.is_integer(),
        "read-only" => v.is_bool(),
        k if FORM_KEYS.contains(&k) => v.is_str(),
        _ => false,
    });
    DbEntry {
        name: name_of(e).unwrap_or_default(),
        kind: s("kind"),
        host: s("host"),
        port: e
            .get("port")
            .and_then(toml::Value::as_integer)
            .map(|n| n.to_string())
            .unwrap_or_default(),
        user: s("user"),
        database: s("database"),
        read_only: e
            .get("read-only")
            .and_then(toml::Value::as_bool)
            .unwrap_or(false),
        tls: s("tls"),
        tls_ca: s("tls-ca"),
        editable: typed,
        overrides: false,
    }
}

/// 設定のフォルダ `dir` の 2 つのファイルの中身から、窓が知る手元の DB の接続を作る。
fn view(dir: &Path, base_text: &str, local_text: &str) -> Result<DbConnections, String> {
    let base: Vec<String> = entries_of(&dir.join(config::FILES[0]), base_text)?
        .iter()
        .filter_map(name_of)
        .collect();
    let local: Vec<DbEntry> = entries_of(&dir.join(config::FILES[1]), local_text)?
        .iter()
        .filter(|e| name_of(e).is_some())
        .map(|e| {
            let mut v = entry_view(e);
            v.overrides = base.contains(&v.name);
            v
        })
        .collect();
    let fixed = base
        .into_iter()
        .filter(|n| !local.iter().any(|l| &l.name == n))
        .collect();
    Ok(DbConnections { local, fixed })
}

/// ファイルの中身（無ければ空）。読めなければ、場所を付けた理由。
fn read(dir: &Path, file: &str) -> Result<String, EditError> {
    let path = dir.join(file);
    Ok(config::read_text(&path)?.unwrap_or_default())
}

/// `config.toml` の中身と、その項目の名前。
fn base(dir: &Path) -> Result<(String, Vec<String>), EditError> {
    let path = dir.join(config::FILES[0]);
    let text = read(dir, config::FILES[0])?;
    let names = entries_of(&path, &text)
        .map_err(EditError::File)?
        .iter()
        .filter_map(name_of)
        .collect();
    Ok((text, names))
}

/// 設定のフォルダ `dir` の、窓が知る手元の DB の接続。
pub fn list(dir: &Path) -> Result<DbConnections, EditError> {
    let (base_text, _) = base(dir)?;
    let local_text = read(dir, config::FILES[1])?;
    view(dir, &base_text, &local_text).map_err(EditError::File)
}

/// 設定のフォルダ `dir` の `config.local.toml` の `[[db.connections]]` に、窓の書き込み `e` を行い、書いたあとの手元の DB の接続を返す。
/// 書き換えたあとの項目を確かめ（[`check_entry`] と窓だけの確かめ）、間違いがあれば何も書かない（[`EditError::Invalid`]）。
pub fn edit(dir: &Path, e: DbEdit) -> Result<DbConnections, EditError> {
    let (base_text, fixed) = base(dir)?;
    let is_fixed = |n: &str| fixed.iter().any(|f| f == n.trim());
    let (target, edit) = list_edit(e, &is_fixed)?;
    let edit_key = match &edit {
        Edit::Update { key, .. } | Edit::Remove { key } => Some(key.clone()),
        Edit::Add(_) => None,
    };
    let mut after = None;
    let mut found = Vec::new();
    let r = config_list::edit(dir, &DB_CONNECTIONS, edit, |text| {
        if let Some(name) = &target {
            let entry = entries_of(&dir.join(config::FILES[1]), text)?
                .into_iter()
                .find(|e| name_of(e).as_deref() == Some(name.as_str()));
            if let Some(entry) = entry {
                found = check_all(&entry);
                if !found.is_empty() {
                    return Err(String::new());
                }
            }
        }
        after = Some(view(dir, &base_text, text)?);
        Ok(())
    });
    match r {
        Ok(()) => Ok(after.unwrap_or_default()),
        // config.toml にだけある接続は、config.local.toml に無い。変えられない理由を返す
        Err(EditError::Missing(k)) if edit_key.as_deref().is_some_and(is_fixed) => {
            Err(EditError::Fixed(k.trim().to_string()))
        }
        // 書き換えたあとの項目の間違い（窓で入れないキーを手で書いた項目を直そうとした、など）
        Err(EditError::Rejected(_)) if !found.is_empty() => Err(EditError::Invalid(found)),
        Err(e) => Err(e),
    }
}

/// 窓の書き込みを、共通の処理（config_list.rs）の書き込みにする。あわせて、書いたあとに確かめる項目の名前（消すときは無し）を返す。
/// 入れた値は書く前に確かめ、`config.toml` の接続を足す（かぶせる）・その名前に変えるのは断る（`is_fixed` は `config.toml` の名前か）。
fn list_edit(
    e: DbEdit,
    is_fixed: &dyn Fn(&str) -> bool,
) -> Result<(Option<String>, Edit), EditError> {
    Ok(match e {
        DbEdit::Add { connection } => {
            let (entry, _) = connection.to_entry().map_err(one)?;
            pre_check(&entry)?;
            let name = name_of(&entry).unwrap_or_default();
            if is_fixed(&name) {
                return Err(EditError::Fixed(name));
            }
            (Some(name), Edit::Add(entry))
        }
        DbEdit::Update { name, connection } => {
            let (set, unset) = connection.to_entry().map_err(one)?;
            pre_check(&set)?;
            let new = name_of(&set).unwrap_or_default();
            // 名前を config.toml の接続の名前に変えるのも、その接続を変えることになる
            if is_fixed(&new) && new != name.trim() {
                return Err(EditError::Fixed(new));
            }
            let unset = unset.into_iter().filter(|k| k != "name").collect();
            (
                Some(new),
                Edit::Update {
                    key: name,
                    set,
                    unset,
                },
            )
        }
        DbEdit::Remove { name } => (None, Edit::Remove { key: name }),
    })
}

fn one(p: Problem) -> EditError {
    EditError::Invalid(vec![p])
}

/// 書く前に、窓で入れた項目を確かめる。
fn pre_check(entry: &toml::Table) -> Result<(), EditError> {
    let probs = check_all(entry);
    if probs.is_empty() {
        Ok(())
    } else {
        Err(EditError::Invalid(probs))
    }
}

/// kisui と同じ確かめ（[`check_entry`]）と、窓だけの確かめ。
pub fn check_all(e: &toml::Table) -> Vec<Problem> {
    // 窓で確かめられないキー（権限の名前は [db.permissions] を、変種は変種ごとの値を見る）。設定ファイルで直す。
    // 変種のある項目は、ユーザーなどを変種に書けるので、ほかのキーの確かめも当てにならない。password だけは添える
    let mut out: Vec<Problem> = FILE_ONLY_KEYS
        .iter()
        .filter(|k| e.contains_key(**k))
        .map(|k| problem(k, "gui.db.fileonly", &[]))
        .collect();
    if !out.is_empty() {
        if e.contains_key("password") {
            out.push(problem("password", "config.err.password", &[]));
        }
        return out;
    }
    out.extend(check_entry(e));
    // 接続の URL や接続の文字列を貼ると、中のパスワードまで平文で書いてしまう（kisui は形を確かめないので、窓で断る）。
    // host は通す形を決める：/ で始まるソケットのパスか、空白・=・@ を含まないホスト名・アドレス（`host=db password=…` の形も止める）
    if let Some(h) = e.get("host").and_then(toml::Value::as_str) {
        if !host_shape(h) {
            out.push(problem("host", "gui.db.hosturl", &[]));
        }
    }
    // ほかの字の欄は、URL（`postgres://user:pass@db/shop`）だけを断る。`@` は user@server の形のユーザー名にありうる
    for k in ["name", "user", "database"] {
        if e.get(k)
            .and_then(toml::Value::as_str)
            .is_some_and(|v| v.contains("://"))
        {
            out.push(problem(k, "gui.db.url", &[]));
        }
    }
    out
}

/// 窓が書いてよい host の形か：`/` で始まるソケットのパス（URL・`@` を含まない）か、空白・`=`・`@`・`/` を含まないホスト名・アドレス。
fn host_shape(h: &str) -> bool {
    if h.contains("://") || h.contains('@') {
        return false;
    }
    h.starts_with('/') || !h.chars().any(|c| c.is_whitespace() || c == '=' || c == '/')
}

/// 1 つの表の値を読む（kisui の `dbEntry`）。
struct Reader<'a> {
    e: &'a toml::Table,
    probs: Vec<Problem>,
}

impl Reader<'_> {
    fn bad(&mut self, key: &str, code: &str, args: &[&str]) {
        self.probs.push(problem(key, code, args));
    }

    /// 文字列のキー。無い・間違いなら None（kisui の `str`）。
    fn str(&mut self, key: &str, required: bool) -> Option<String> {
        let Some(v) = self.e.get(key) else {
            if required {
                self.bad(key, "config.err.required", &[]);
            }
            return None;
        };
        match v.as_str() {
            None => self.bad(key, "config.err.string", &[]),
            Some(s) if s.trim().is_empty() && required => self.bad(key, "config.err.required", &[]),
            Some(s) if s.chars().any(char::is_control) => self.bad(key, "config.err.control", &[]),
            Some(s) => return Some(s.to_string()),
        }
        None
    }
}

/// kisui の `integer`：整数か、小数点以下の無い小数。
fn integer(v: &toml::Value) -> Option<i64> {
    match v {
        toml::Value::Integer(n) => Some(*n),
        toml::Value::Float(f) if f.fract() == 0.0 && f.is_finite() => Some(*f as i64),
        _ => None,
    }
}

/// kisui の `ExpandHome` が受ける形か（`~`・`~/…`・絶対パス）。
fn home_or_abs(s: &str) -> bool {
    s == "~" || s.starts_with("~/") || s.starts_with('/')
}

/// `[[db.connections]]` の項目 1 つ（変種の無いもの）の間違い。kisui の `config/db.go` の `dbConnection` と同じキー・コード・値を、
/// 同じ順で返す（権限は無いものとして読む。変種と権限のキーは、kisui の確かめにそのまま任せず [`check_all`] が窓の理由にする）。
pub fn check_entry(e: &toml::Table) -> Vec<Problem> {
    let mut d = Reader {
        e,
        probs: Vec::new(),
    };
    // 知らないキー（並べ替えた順）と password
    let mut keys: Vec<&String> = e.keys().collect();
    keys.sort();
    let known = DB_KEYS.join(", ");
    for k in keys {
        if !DB_KEYS.contains(&k.as_str()) && k != "password" {
            d.bad(k, "config.err.unknown", &[&known]);
        }
    }
    if e.contains_key("password") {
        d.bad("password", "config.err.password", &[]);
    }
    if let Some(s) = d.str("name", true) {
        if s.chars().count() > NAME_MAX {
            d.bad("name", "config.err.toolong", &[&NAME_MAX.to_string()]);
        }
    }
    if let Some(s) = d.str("kind", true) {
        if s != "postgres" && s != "mysql" {
            d.bad("kind", "config.err.oneof", &["postgres, mysql"]);
        }
    }
    // 権限（窓では書かない。権限の一覧を持たないので、ここでは読まない）
    let w = d.where_keys();
    // fill：user だけは既定が無い
    if w.user.is_none() && !e.contains_key("user") {
        d.bad("user", "config.err.required", &[]);
    }
    d.check_tls(&w);
    d.probs
}

/// kisui の `dbWhere`（の、窓が書くキーの分）。書いていない・間違っているキーは None。
struct Where {
    host: Option<String>,
    user: Option<String>,
    tls: Option<String>,
    /// `tls` を書いたが間違っている（報告した）
    tls_wrong: bool,
    /// 使える `tls-ca` を書いた
    tls_ca: bool,
}

impl Reader<'_> {
    /// kisui の `where`：どこの DB に誰がつなぐかのキーを読む。
    fn where_keys(&mut self) -> Where {
        let e = self.e;
        let host = self.str("host", false).filter(|s| !s.is_empty());
        if let Some(v) = e.get("port") {
            match integer(v) {
                None => self.bad("port", "config.err.int", &[]),
                Some(n) if !(1..=65535).contains(&n) => self.bad("port", "config.err.port", &[]),
                Some(_) => {}
            }
        }
        let user = if e.contains_key("user") {
            self.str("user", true)
        } else {
            None
        };
        self.str("database", false);
        if let Some(v) = e.get("read-only") {
            if !v.is_bool() {
                self.bad("read-only", "config.err.bool", &[]);
            }
        }
        let mut tls = None;
        if let Some(s) = self.str("tls", false) {
            if TLS_MODES.contains(&s.as_str()) {
                tls = Some(s);
            } else {
                self.bad("tls", "config.err.oneof", &[&TLS_MODES.join(", ")]);
            }
        }
        let tls_wrong = e.contains_key("tls") && tls.is_none();
        let mut tls_ca = false;
        if let Some(s) = self.str("tls-ca", false) {
            if home_or_abs(&s) {
                tls_ca = true;
            } else {
                self.bad("tls-ca", "config.err.abspath", &[]);
            }
        }
        Where {
            host,
            user,
            tls,
            tls_wrong,
            tls_ca,
        }
    }

    /// kisui の `checkTLS`：TLS の組み合わせで成り立たないもの（既定を入れたあとの値で見る）。
    fn check_tls(&mut self, w: &Where) {
        let host = w.host.as_deref().unwrap_or("localhost");
        let tls = w.tls.as_deref().unwrap_or("prefer");
        if host.starts_with('/') && (tls == "require" || tls == "verify") {
            self.bad("tls", "config.err.tlssocket", &["prefer, disable"]);
        }
        if w.tls_ca && !w.tls_wrong && tls != "verify" {
            self.bad("tls-ca", "config.err.tlsca", &["verify"]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kisui-db-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn fields(name: &str) -> DbFields {
        DbFields {
            name: name.into(),
            kind: "postgres".into(),
            user: "app".into(),
            ..Default::default()
        }
    }

    /// kisui（config/db_window_test.go）と同じ例で、同じ間違いになる。
    #[test]
    fn same_problems_as_kisui() {
        #[derive(Deserialize)]
        struct Case {
            entry: String,
            problems: Vec<Vec<String>>,
        }
        let cases: Vec<Case> = serde_json::from_str(include_str!("config_db_cases.json")).unwrap();
        assert!(cases.len() > 10);
        for c in cases {
            let e: toml::Table = c.entry.parse().unwrap();
            let mut got: Vec<Vec<String>> = check_entry(&e)
                .into_iter()
                .map(|p| {
                    let mut v = vec![p.key, p.code];
                    v.extend(p.args);
                    v
                })
                .collect();
            let mut want = c.problems.clone();
            got.sort();
            want.sort();
            assert_eq!(got, want, "{}", c.entry);
        }
    }

    // 足す・直す・消すと config.local.toml の [[db.connections]] が変わり、ほかは残る。パスワードは書かない
    #[test]
    fn add_update_remove() {
        let d = temp_dir("aur");
        fs::write(
            d.join("config.local.toml"),
            "# 手で書いた\nui-language = \"ja\"\n",
        )
        .unwrap();
        let mut f = fields("shop");
        f.host = " db.local ".into();
        f.port = "6543".into();
        f.tls = "require".into();
        let v = edit(&d, DbEdit::Add { connection: f }).unwrap();
        assert_eq!(v.local.len(), 1);
        assert!(v.local[0].editable);
        assert_eq!(v.local[0].host, "db.local");
        let text = fs::read_to_string(d.join("config.local.toml")).unwrap();
        assert_eq!(
            text,
            "# 手で書いた\nui-language = \"ja\"\n\n[[db.connections]]\nname = \"shop\"\nhost = \"db.local\"\nkind = \"postgres\"\nport = 6543\ntls = \"require\"\nuser = \"app\"\n"
        );
        assert!(!text.contains("password"));

        // 直す：名前を変え、ポートと TLS を空に（消す）、読み取り専用にする
        let mut f = fields("shop2");
        f.host = "db.local".into();
        f.read_only = true;
        let v = edit(
            &d,
            DbEdit::Update {
                name: "shop".into(),
                connection: f,
            },
        )
        .unwrap();
        assert_eq!(v.local[0].name, "shop2");
        assert!(v.local[0].read_only);
        let text = fs::read_to_string(d.join("config.local.toml")).unwrap();
        assert!(!text.contains("port"));
        assert!(!text.contains("tls"));
        assert!(text.contains("read-only = true"));

        // 消す
        let v = edit(
            &d,
            DbEdit::Remove {
                name: "shop2".into(),
            },
        )
        .unwrap();
        assert!(v.local.is_empty());
        assert_eq!(
            fs::read_to_string(d.join("config.local.toml")).unwrap(),
            "# 手で書いた\nui-language = \"ja\"\n"
        );
    }

    // config.toml の接続は窓から変えられない（足す・直す・消す・名前を変えてかぶせる）
    #[test]
    fn fixed_connections() {
        let d = temp_dir("fixed");
        fs::write(
            d.join("config.toml"),
            "[[db.connections]]\nname = \"prod\"\nkind = \"mysql\"\nuser = \"r\"\n",
        )
        .unwrap();
        let v = list(&d).unwrap();
        assert_eq!(v.fixed, vec!["prod".to_string()]);
        assert_eq!(
            edit(
                &d,
                DbEdit::Add {
                    connection: fields(" prod ")
                }
            ),
            Err(EditError::Fixed("prod".into()))
        );
        assert_eq!(
            edit(
                &d,
                DbEdit::Update {
                    name: "prod".into(),
                    connection: fields("prod")
                }
            ),
            Err(EditError::Fixed("prod".into()))
        );
        assert_eq!(
            edit(
                &d,
                DbEdit::Remove {
                    name: "prod".into()
                }
            ),
            Err(EditError::Fixed("prod".into()))
        );
        edit(
            &d,
            DbEdit::Add {
                connection: fields("dev"),
            },
        )
        .unwrap();
        assert_eq!(
            edit(
                &d,
                DbEdit::Update {
                    name: "dev".into(),
                    connection: fields("prod")
                }
            ),
            Err(EditError::Fixed("prod".into()))
        );
        // 手で書いた上書き：印が付き、消すと config.toml の接続に戻る（断らない）
        let mut local = fs::read_to_string(d.join("config.local.toml")).unwrap();
        local.push_str("\n[[db.connections]]\nname = \"prod\"\nkind = \"mysql\"\nuser = \"r\"\nread-only = true\n");
        fs::write(d.join("config.local.toml"), local).unwrap();
        let v = list(&d).unwrap();
        assert!(v.local.iter().any(|e| e.name == "prod" && e.overrides));
        assert!(v.local.iter().any(|e| e.name == "dev" && !e.overrides));
        assert!(v.fixed.is_empty());
        let v = edit(
            &d,
            DbEdit::Remove {
                name: "prod".into(),
            },
        )
        .unwrap();
        assert_eq!(v.fixed, vec!["prod".to_string()]);
        // config.toml は読むだけ
        assert_eq!(
            fs::read_to_string(d.join("config.toml")).unwrap(),
            "[[db.connections]]\nname = \"prod\"\nkind = \"mysql\"\nuser = \"r\"\n"
        );
    }

    // 間違いがあれば書かずに、kisui と同じキーとコードで返す
    #[test]
    fn invalid_is_not_written() {
        let d = temp_dir("invalid");
        let mut f = fields("x");
        f.port = "70000".into();
        f.host = "/tmp/sock".into();
        f.tls = "verify".into();
        let Err(EditError::Invalid(p)) = edit(&d, DbEdit::Add { connection: f }) else {
            panic!()
        };
        let codes: Vec<_> = p
            .iter()
            .map(|p| (p.key.as_str(), p.code.as_str()))
            .collect();
        assert_eq!(
            codes,
            [("port", "config.err.port"), ("tls", "config.err.tlssocket")]
        );
        let mut f = fields("x");
        f.port = "abc".into();
        assert_eq!(
            edit(&d, DbEdit::Add { connection: f }),
            Err(EditError::Invalid(vec![problem(
                "port",
                "config.err.int",
                &[]
            )]))
        );
        let mut f = fields("x");
        f.host = "app:secret@db.example".into();
        let Err(EditError::Invalid(p)) = edit(&d, DbEdit::Add { connection: f }) else {
            panic!()
        };
        assert_eq!(p, vec![problem("host", "gui.db.hosturl", &[])]);
        // 接続の文字列・ほかの欄の URL も断る。ソケットのパス・IPv6 のアドレスは通す
        let mut f = fields("x");
        f.host = "db password=secret".into();
        f.database = "postgres://app:secret@db/shop".into();
        let Err(EditError::Invalid(p)) = edit(&d, DbEdit::Add { connection: f }) else {
            panic!()
        };
        assert_eq!(
            p,
            vec![
                problem("host", "gui.db.hosturl", &[]),
                problem("database", "gui.db.url", &[])
            ]
        );
        for h in ["/run/postgresql", "::1", "db-1.example.com", "10.0.0.1"] {
            assert!(host_shape(h), "{h}");
        }
        // 間違いの中に、入れた値（パスワードになりうる host の中身）は入れない
        assert!(!format!("{p:?}").contains("secret"));
        assert!(!d.join("config.local.toml").exists());
    }

    // 窓で入れないキー（権限・変種・password）を手で書いた項目：直せない印を付け、直そうとしたら断る。消すことはできる
    #[test]
    fn hand_written_entries() {
        let d = temp_dir("hand");
        let src = "[[db.connections]]\nname = \"a\"\nkind = \"postgres\"\nuser = \"u\"\nhuman-permission = \"ro\"\n\n[[db.connections]]\nname = \"b\"\nkind = \"postgres\"\nuser = \"u\"\npassword = \"hunter2\"\n";
        fs::write(d.join("config.local.toml"), src).unwrap();
        let v = list(&d).unwrap();
        assert!(!v.local[0].editable && !v.local[1].editable);
        let r = edit(
            &d,
            DbEdit::Update {
                name: "a".into(),
                connection: fields("a"),
            },
        );
        assert_eq!(
            r,
            Err(EditError::Invalid(vec![problem(
                "human-permission",
                "gui.db.fileonly",
                &[]
            )]))
        );
        let Err(EditError::Invalid(p)) = edit(
            &d,
            DbEdit::Update {
                name: "b".into(),
                connection: fields("b"),
            },
        ) else {
            panic!()
        };
        assert_eq!(p, vec![problem("password", "config.err.password", &[])]);
        assert!(!format!("{p:?}").contains("hunter2"));
        assert_eq!(
            fs::read_to_string(d.join("config.local.toml")).unwrap(),
            src
        );
        edit(&d, DbEdit::Remove { name: "b".into() }).unwrap();
        assert_eq!(list(&d).unwrap().local.len(), 1);
    }

    // 読めないファイルの理由は場所だけで、間違いの行の中身（パスワードを含むことがある）を出さない
    #[test]
    fn unreadable_file_hides_the_line() {
        let d = temp_dir("broken");
        fs::write(
            d.join("config.local.toml"),
            "[[db.connections]]\nname = \"a\"\npassword = \"hunter2\n",
        )
        .unwrap();
        let Err(EditError::File(why)) = list(&d) else {
            panic!()
        };
        assert!(
            why.ends_with("config.local.toml:3: TOML として読めません"),
            "{why}"
        );
        let Err(EditError::File(why)) = edit(
            &d,
            DbEdit::Add {
                connection: fields("b"),
            },
        ) else {
            panic!()
        };
        assert!(!why.contains("hunter2"), "{why}");
    }

    // 新しく作る config.local.toml は、持ち主だけが読み書きできる
    #[cfg(unix)]
    #[test]
    fn new_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let d = temp_dir("mode");
        edit(
            &d,
            DbEdit::Add {
                connection: fields("a"),
            },
        )
        .unwrap();
        let m = fs::metadata(d.join("config.local.toml")).unwrap();
        assert_eq!(m.permissions().mode() & 0o777, 0o600);
    }
}
