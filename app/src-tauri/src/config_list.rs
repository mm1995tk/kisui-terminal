//! `config.local.toml` の一覧（`[[gui.machines]]`・`[[db.connections]]`）の項目を、窓から 1 件ずつ足す・変える・消す。
//!
//! 一覧は、読むときに項目ごとに重なる（マシンは ssh の行き先、DB の接続は名前。config.rs と kisui の `config/db.go`）。
//! そこで窓は、自分が持つ項目だけを `config.local.toml` に書けばよく、`config.toml`（home-manager が読み取り専用で置くことがある）は
//! 読むだけで、書かない。ここは、その「1 件を書く」処理を、一覧の種類によらない形で持つ。
//!
//! - **項目を見分けるキー**：一覧ごとに 1 つ（[`List::key`]。マシンは `ssh`、DB の接続は `name`）。前後の空白を除いて比べる。
//! - **足す**（[`Edit::Add`]）：同じキーの項目が `config.local.toml` にあれば断る。`config.toml` にだけある項目と同じキーなら、
//!   その項目に代わる項目を足すことになる（読むときに `config.local.toml` の項目が勝つ）。
//! - **変える**（[`Edit::Update`]）：渡したキーだけを書き換え、`unset` のキーを消す。渡していないキーは残す
//!   （窓が知らないキー、たとえば新しい版や手で書いたキーを、窓の書き込みで消さないため）。見分けるキー自身も変えられる。
//! - **消す**（[`Edit::Remove`]）：`config.local.toml` の項目を消す。`config.toml` の項目は消せない（`config.local.toml` に無いので [`EditError::Missing`]）。
//! - **残すもの**：ほかの表・ほかの項目・コメント・並び。`[[gui.machines]]` の書き方にも、`machines = [{ ssh = "a" }]` の書き方（空の `machines = []` も）にも、
//!   書いてある形のまま書く。一覧が無ければ `[[gui.machines]]` の形で作る。
//!   項目を消すと、見出しのすぐ上に続けて書いたコメントは項目と一緒に消える。空の行で離したコメントは残す。
//! - **書く前の確かめ**：書き換えたあとの中身を `check` に渡し、Err なら書かない。マシンは [`edit_machines`] が、窓の読み込み（config.rs）と
//!   同じ確かめを通す（間違いのある設定を書くと、次の起動で窓が出ないため）。DB の接続の中身を確かめるのは kisui（`config/db.go`）なので、
//!   窓から DB の接続を書く側（#486）が、同じ結果になる確かめを `check` に渡す。
//!
//! 呼ぶのは、窓でマシンを足す・名前を変える・外す処理（[`edit_machine`]。Tauri のコマンド `config_machine_edit`）と、
//! DB の接続を登録する処理（#486）。
//!
//! 窓のマシンの一覧は、設定ファイルだけが持つ（webview の localStorage には置かない。前の版が置いた記録は、
//! 窓が起動したときに 1 度だけ `config.local.toml` に移す。app/src/features/sessions/moveRecords.ts）。
//! 窓が書き換えられるのは `config.local.toml` の項目だけで、`config.toml` にだけあるマシンは変えない（[`EditError::Missing`]）。

use std::fmt;
use std::path::Path;

use serde::{Deserialize, Serialize};
use toml_edit::{Array, ArrayOfTables, DocumentMut, InlineTable, Item, Table, TableLike, Value};

use crate::config::{self, ConfigMachine};

/// 設定の一覧 1 つ（`[[<table>.<name>]]`）と、その項目を見分けるキー。
pub struct List {
    /// 一覧を持つ表（`gui`）
    pub table: &'static str,
    /// 一覧の名前（`machines`）
    pub name: &'static str,
    /// 項目を見分けるキー（`ssh`）。値は文字列
    pub key: &'static str,
}

/// `[[gui.machines]]`。ssh の行き先で見分ける。
pub const MACHINES: List = List {
    table: "gui",
    name: "machines",
    key: "ssh",
};

/// `[[db.connections]]`。名前で見分ける。
// DB の接続を窓から書く処理（#486）が入るまで、テストのほかに使う所は無い
#[allow(dead_code)]
pub const DB_CONNECTIONS: List = List {
    table: "db",
    name: "connections",
    key: "name",
};

/// 一覧の項目 1 件への書き込み。
pub enum Edit {
    /// 項目を足す。見分けるキーを含むこと。配列の中の表（`variants`）は `[[db.connections.variants]]` の形で書く
    Add(toml::Table),
    /// `key` の項目の、`set` のキーを書き換え、`unset` のキーを消す。ほかのキーは残す
    Update {
        key: String,
        set: toml::Table,
        unset: Vec<String>,
    },
    /// `key` の項目を消す
    Remove { key: String },
}

/// 書けなかった理由。画面が言葉を選べるよう、種類で分ける。中の文字列は、設定の間違いと同じ形の説明（ファイルの場所を含む）。
/// 画面へは `{ kind, detail }` の形で渡す（画面が `kind` で言葉を選び、`detail` を添える）。
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "lowercase")]
pub enum EditError {
    /// 同じキーの項目が `config.local.toml` にもうある（中身はそのキー）
    Exists(String),
    /// そのキーの項目が `config.local.toml` に無い（中身はそのキー）。`config.toml` にだけある項目も、こうなる
    Missing(String),
    /// 渡した項目が使えない（見分けるキーが無い・文字列でない、など）
    Entry(String),
    /// `config.local.toml` を読めない・TOML として壊れている・一覧の形でない・書けない
    File(String),
    /// 書き換えたあとの設定が、確かめを通らない
    Rejected(String),
}

impl From<String> for EditError {
    fn from(s: String) -> Self {
        EditError::File(s)
    }
}

impl fmt::Display for EditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EditError::Exists(k) => write!(f, "{k} は config.local.toml にもうあります"),
            EditError::Missing(k) => write!(f, "{k} は config.local.toml にありません"),
            EditError::Entry(s) | EditError::File(s) | EditError::Rejected(s) => f.write_str(s),
        }
    }
}

/// 窓のマシンの書き込み 1 つ（画面の `MachineEdit`。app/src/features/sessions/shell.ts）。
/// `name` は付けた名前で、空白だけ・無いなら名前を付けない（ssh の行き先を出す）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MachineEdit {
    /// 足す（「リモートを足す」でつながったとき）
    Add { ssh: String, name: Option<String> },
    /// 名前を変える
    Rename { ssh: String, name: Option<String> },
    /// 外す
    Remove { ssh: String },
}

impl MachineEdit {
    fn into_edit(self) -> Edit {
        let name = |n: Option<String>| {
            n.map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
                .map(toml::Value::String)
        };
        match self {
            MachineEdit::Add { ssh, name: n } => {
                let mut t = toml::Table::new();
                t.insert("ssh".into(), toml::Value::String(ssh.trim().to_string()));
                if let Some(n) = name(n) {
                    t.insert("name".into(), n);
                }
                Edit::Add(t)
            }
            MachineEdit::Rename { ssh, name: n } => match name(n) {
                Some(n) => Edit::Update {
                    key: ssh,
                    set: toml::Table::from_iter([("name".to_string(), n)]),
                    unset: vec![],
                },
                None => Edit::Update {
                    key: ssh,
                    set: toml::Table::new(),
                    unset: vec!["name".into()],
                },
            },
            MachineEdit::Remove { ssh } => Edit::Remove { key: ssh },
        }
    }
}

/// 設定のフォルダ `dir` の `config.local.toml` の `[[gui.machines]]` に、窓のマシンの書き込み `e` を行い、
/// 書いたあとの（2 つのファイルを重ねた）マシンの一覧を返す。画面はこの一覧で、サイドバーを描き直す。
pub fn edit_machine(dir: &Path, e: MachineEdit) -> Result<Vec<ConfigMachine>, EditError> {
    edit_machines(dir, e.into_edit())
}

/// 設定のフォルダ `dir` の `config.local.toml` の一覧 `list` に、`edit` を行う。
/// 書き換えたあとの中身を `check` に渡し、Err なら書かない（[`EditError::Rejected`]）。
pub fn edit(
    dir: &Path,
    list: &List,
    edit: Edit,
    check: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), EditError> {
    config::edit_local(dir, |doc, path| {
        apply(doc, list, edit).map_err(|e| match e {
            EditError::File(s) => EditError::File(format!("{}: {s}", path.display())),
            e => e,
        })?;
        check(&doc.to_string()).map_err(EditError::Rejected)
    })
}

/// `[[gui.machines]]` に `edit` を行い、書いたあとの（2 つのファイルを重ねた）マシンの一覧を返す。
/// 書き換えたあとの設定を、窓の読み込みと同じに確かめる（使えない ssh の行き先、`config.toml` のマシンとの名前の重なり、など）。
/// 返す一覧は、その確かめで書く中身から作る。確かめは書き込みと同じ排他（`config::edit_local`）の中で行うので、
/// 書き込みが続けて走っても、返す一覧はその書き込みの直後のものになる（書いたあとに読み直すと、次の書き込みと入れ違う）。
pub fn edit_machines(dir: &Path, e: Edit) -> Result<Vec<ConfigMachine>, EditError> {
    let mut machines = Vec::new();
    edit(dir, &MACHINES, e, |text| {
        machines = config::load_with_local(dir, text)?.machines;
        Ok(())
    })?;
    Ok(machines)
}

/// 項目の、見分けるキーの値（前後の空白を除く）。無い・文字列でないなら None。
fn key_of(entry: &dyn TableLike, key: &str) -> Option<String> {
    Some(entry.get(key)?.as_str()?.trim().to_string())
}

/// 渡された項目の、見分けるキーの値。
fn key_in(list: &List, entry: &toml::Table) -> Result<String, EditError> {
    match entry.get(list.key).and_then(|v| v.as_str()).map(str::trim) {
        Some(k) if !k.is_empty() => Ok(k.to_string()),
        _ => Err(EditError::Entry(format!(
            "{}.{}: {} を文字列で書きます",
            list.table, list.name, list.key
        ))),
    }
}

/// 読んだ中身 `doc` の一覧に `edit` を行う。
fn apply(doc: &mut DocumentMut, list: &List, edit: Edit) -> Result<(), EditError> {
    match edit {
        Edit::Add(entry) => add(doc, list, &entry),
        Edit::Update { key, set, unset } => update(doc, list, &key, &set, &unset),
        Edit::Remove { key } => remove(doc, list, &key),
    }
}

/// 形が違うときの理由（`what` ではありません）。
fn shape(what: &str) -> EditError {
    EditError::File(format!("{what} ではありません"))
}

/// 一覧を持つ表（`[gui]`）。無ければ None。表でなければ Err。
fn parent_of<'a>(doc: &'a mut DocumentMut, list: &List) -> Result<Option<&'a mut Item>, EditError> {
    match doc.as_table_mut().get_mut(list.table) {
        None => Ok(None),
        Some(item) if item.is_table_like() => Ok(Some(item)),
        Some(_) => Err(shape(&format!("[{}] が表", list.table))),
    }
}

/// 一覧の 2 つの書き方。
enum Entries<'a> {
    /// `[[gui.machines]]`
    Tables(&'a mut ArrayOfTables),
    /// `machines = [{ ssh = "a" }]`（1 行の表の配列。空の配列も）
    Inline(&'a mut Array),
}

impl<'a> Entries<'a> {
    /// 表 `parent` の中の一覧。無ければ None。表の一覧でなければ Err。
    fn of(parent: &'a mut dyn TableLike, list: &List) -> Result<Option<Self>, EditError> {
        match parent.get_mut(list.name) {
            None => Ok(None),
            Some(Item::ArrayOfTables(a)) => Ok(Some(Entries::Tables(a))),
            Some(Item::Value(Value::Array(a))) if a.iter().all(Value::is_inline_table) => {
                Ok(Some(Entries::Inline(a)))
            }
            Some(_) => Err(shape(&format!("{}.{} が表の一覧", list.table, list.name))),
        }
    }

    /// 見分けるキーが `key` の項目の番号（前後の空白を除いて比べる）。
    fn find(&self, list: &List, key: &str) -> Option<usize> {
        let is = |t: &dyn TableLike| key_of(t, list.key).as_deref() == Some(key.trim());
        match self {
            Entries::Tables(a) => a.iter().position(|t| is(t)),
            Entries::Inline(a) => a
                .iter()
                .position(|v| v.as_inline_table().is_some_and(|t| is(t))),
        }
    }

    /// 後ろに 1 件足す（書いてある形のまま）。
    fn push(&mut self, list: &List, entry: &toml::Table) {
        match self {
            Entries::Tables(a) => a.push(new_table(list, entry, "\n")),
            Entries::Inline(a) => a.push(Value::InlineTable(new_inline(list, entry))),
        }
    }
}

/// 足す。一覧が無ければ作る。
fn add(doc: &mut DocumentMut, list: &List, entry: &toml::Table) -> Result<(), EditError> {
    let key = key_in(list, entry)?;
    // 1 件目を足すとき、見出しの前に書くもの。何か書いてあるファイルでは、前との間を 1 行空ける。
    // 表もキーも無いファイルのコメントは、toml_edit が「ファイルの終わりに書くもの」として持っているので、
    // そのままでは足した 1 件の下に出る。見出しの前に移す
    let prefix = if doc.as_table().is_empty() {
        let comments = doc.trailing().as_str().unwrap_or("").trim_end().to_string();
        doc.set_trailing("");
        if comments.is_empty() {
            comments
        } else {
            format!("{comments}\n\n")
        }
    } else {
        "\n".to_string()
    };
    if doc.as_table().get(list.table).is_none() {
        // 見出し（`[gui]`）は出さず、`[[gui.machines]]` だけを書く
        let mut t = Table::new();
        t.set_implicit(true);
        doc.as_table_mut().insert(list.table, Item::Table(t));
    }
    let parent_item = parent_of(doc, list)?.expect("上で足した");
    // 表（`[gui]`）の中なら `[[gui.machines]]` の形で、1 行の表（`gui = { … }`）の中なら 1 行の配列で書く
    let in_table = parent_item.is_table();
    let parent = parent_item
        .as_table_like_mut()
        .expect("parent_of が確かめた");
    if let Some(mut entries) = Entries::of(parent, list)? {
        if entries.find(list, &key).is_some() {
            return Err(EditError::Exists(key));
        }
        entries.push(list, entry);
        return Ok(());
    }
    let new = if in_table {
        let mut a = ArrayOfTables::new();
        a.push(new_table(list, entry, &prefix));
        Item::ArrayOfTables(a)
    } else {
        let mut a = Array::new();
        a.push(Value::InlineTable(new_inline(list, entry)));
        Item::Value(Value::Array(a))
    };
    parent.insert(list.name, new);
    Ok(())
}

/// 変える。`key` の項目の、`set` のキーを書き換え、`unset` のキーを消す。
fn update(
    doc: &mut DocumentMut,
    list: &List,
    key: &str,
    set: &toml::Table,
    unset: &[String],
) -> Result<(), EditError> {
    let missing = || EditError::Missing(key.to_string());
    let parent = parent_of(doc, list)?
        .and_then(Item::as_table_like_mut)
        .ok_or_else(missing)?;
    let entries = Entries::of(parent, list)?.ok_or_else(missing)?;
    let at = entries.find(list, key).ok_or_else(missing)?;
    if set.contains_key(list.key) {
        let new_key = key_in(list, set)?;
        if entries.find(list, &new_key).is_some_and(|i| i != at) {
            return Err(EditError::Exists(new_key));
        }
    }
    if unset.iter().any(|k| k == list.key) {
        return Err(EditError::Entry(format!(
            "{}.{}: {} は消せません",
            list.table, list.name, list.key
        )));
    }
    let (entry, as_table): (&mut dyn TableLike, bool) = match entries {
        Entries::Tables(a) => (a.get_mut(at).expect("上で見つけた"), true),
        Entries::Inline(a) => (
            a.get_mut(at)
                .and_then(Value::as_inline_table_mut)
                .expect("上で見つけた"),
            false,
        ),
    };
    for (k, v) in set {
        set_value(entry, k, v, as_table);
    }
    for k in unset {
        entry.remove(k);
    }
    Ok(())
}

/// 消す。最後の 1 件を消したら、`[[…]]` の一覧は一覧ごと無くす。
fn remove(doc: &mut DocumentMut, list: &List, key: &str) -> Result<(), EditError> {
    let missing = || EditError::Missing(key.to_string());
    // 消したあとに、残すコメントを付け替える先を探すため、先に全部の表の場所を見ておく
    let mut positions = Vec::new();
    table_positions(doc.as_table(), &mut positions);
    // 表の前に書く、表に入らない項目（`ui-language = "ja"` など）があるか
    let top_values = doc
        .as_table()
        .iter()
        .any(|(_, i)| i.is_value() || i.as_table().is_some_and(Table::is_dotted));

    let parent = parent_of(doc, list)?
        .and_then(Item::as_table_like_mut)
        .ok_or_else(missing)?;
    let entries = Entries::of(parent, list)?.ok_or_else(missing)?;
    let at = entries.find(list, key).ok_or_else(missing)?;
    let mut removed = None;
    match entries {
        Entries::Tables(a) => {
            let t = a.get(at).expect("上で見つけた");
            let kept = kept_comments(t.decor().prefix().and_then(|p| p.as_str()));
            removed = t.position().map(|p| (p, kept));
            // 消す 1 件の配下の表（`[[db.connections.variants]]`）は一緒に消えるので、付け替える先にしない
            let mut inner = Vec::new();
            table_positions(t, &mut inner);
            positions.retain(|p| !inner.contains(p));
            a.remove(at);
            if a.is_empty() {
                parent.remove(list.name);
            }
        }
        Entries::Inline(a) => {
            // 消した項目の前の空白（改行と字下げ）は、その場所に詰めてくる項目が引き継ぐ。
            // 書いた人の `machines = [ … ]` の形は、空になっても残す（空の一覧は、読むときに何もしない）
            let gone = a.remove(at);
            if let (Some(next), Some(prefix)) = (a.get_mut(at), gone.decor().prefix()) {
                next.decor_mut().set_prefix(prefix.clone());
            }
        }
    }
    if let Some((position, kept)) = removed {
        let at_start = !top_values && positions.iter().all(|&p| p >= position);
        mend_after_remove(doc, &positions, position, &kept, at_start);
    }
    Ok(())
}

/// 項目のキー `key` を `value` にする。前の値があれば、その前後の空白と行末のコメントを残す。
fn set_value(entry: &mut dyn TableLike, key: &str, value: &toml::Value, as_table: bool) {
    let mut new = if as_table {
        to_item(value)
    } else {
        Item::Value(to_value(value))
    };
    if let (Some(old), Some(nv)) = (entry.get(key).and_then(Item::as_value), new.as_value_mut()) {
        *nv.decor_mut() = old.decor().clone();
    }
    entry.insert(key, new);
}

/// 足す項目を、`[[…]]` の 1 件にする。見分けるキーを先頭に書く。`prefix` は、見出しの前に書くもの
/// （前に書いてあるものとの間を空ける空の行）。
fn new_table(list: &List, entry: &toml::Table, prefix: &str) -> Table {
    let mut t = Table::new();
    for (k, v) in ordered(list, entry) {
        t.insert(k, to_item(v));
    }
    t.decor_mut().set_prefix(prefix);
    t
}

/// 足す項目を、1 行の表（`{ ssh = "a" }`）にする。
fn new_inline(list: &List, entry: &toml::Table) -> InlineTable {
    let mut t = InlineTable::new();
    for (k, v) in ordered(list, entry) {
        t.insert(k, to_value(v));
    }
    t
}

/// 項目のキーと値を、見分けるキーを先頭にして並べる。
fn ordered<'a>(
    list: &List,
    entry: &'a toml::Table,
) -> impl Iterator<Item = (&'a String, &'a toml::Value)> {
    let key = list.key;
    entry
        .iter()
        .filter(move |(k, _)| *k == key)
        .chain(entry.iter().filter(move |(k, _)| *k != key))
}

/// 表の中に書く値。表だけの配列（`variants`）は `[[….variants]]` の形に、ほかは 1 行の値にする。
fn to_item(v: &toml::Value) -> Item {
    match v {
        toml::Value::Array(a) if !a.is_empty() && a.iter().all(toml::Value::is_table) => {
            let mut out = ArrayOfTables::new();
            for t in a.iter().filter_map(toml::Value::as_table) {
                let mut table = Table::new();
                for (k, v) in t {
                    table.insert(k, to_item(v));
                }
                out.push(table);
            }
            Item::ArrayOfTables(out)
        }
        _ => Item::Value(to_value(v)),
    }
}

/// 1 行で書く値。
fn to_value(v: &toml::Value) -> Value {
    match v {
        toml::Value::String(s) => Value::from(s.as_str()),
        toml::Value::Integer(i) => Value::from(*i),
        toml::Value::Float(f) => Value::from(*f),
        toml::Value::Boolean(b) => Value::from(*b),
        toml::Value::Datetime(d) => Value::from(*d),
        toml::Value::Array(a) => Value::Array(a.iter().map(to_value).collect()),
        toml::Value::Table(t) => {
            let mut out = InlineTable::new();
            for (k, v) in t {
                out.insert(k, to_value(v));
            }
            Value::InlineTable(out)
        }
    }
}

/// 消す項目の見出しの前に書いてあるもの（`prefix`）のうち、残すコメント。
/// 見出しのすぐ上に続くコメントは項目のものとして消し、空の行より前のコメント（ファイルの頭の説明など）は、空の行ごと残す。
fn kept_comments(prefix: Option<&str>) -> String {
    let lines: Vec<&str> = prefix.unwrap_or("").split_inclusive('\n').collect();
    let Some(blank) = lines.iter().rposition(|l| l.trim().is_empty()) else {
        return String::new();
    };
    if lines[..blank].iter().all(|l| l.trim().is_empty()) {
        return String::new();
    }
    lines[..=blank].concat()
}

/// 見出しを書く表（`[x]` と `[[x]]` の 1 件）の、ファイルの中の場所を集める。
fn table_positions(table: &Table, out: &mut Vec<isize>) {
    for (_, item) in table.iter() {
        match item {
            Item::Table(t) => {
                if !t.is_implicit() && !t.is_dotted() {
                    out.extend(t.position());
                }
                table_positions(t, out);
            }
            Item::ArrayOfTables(a) => {
                for t in a.iter() {
                    out.extend(t.position());
                    table_positions(t, out);
                }
            }
            _ => {}
        }
    }
}

/// 先頭の空の行を除いたもの。
fn without_leading_blank_lines(text: &str) -> &str {
    let mut rest = text;
    while let Some(line) = rest.split_inclusive('\n').next() {
        if !line.trim().is_empty() {
            break;
        }
        rest = &rest[line.len()..];
    }
    rest
}

/// 項目（場所 `removed`）を消したあとを整える。項目の前にあった、残すコメント `kept` を、ファイルの中で次に来る表の前に付ける
/// （次の表が無ければ、ファイルの終わりに付ける）。空の行が 2 つ続かないよう、また、ファイルの頭の項目を消したとき
/// （`at_start`）にファイルが空の行で始まらないよう、次の表の前の空の行を除く。
fn mend_after_remove(
    doc: &mut DocumentMut,
    positions: &[isize],
    removed: isize,
    kept: &str,
    at_start: bool,
) {
    if kept.is_empty() && !at_start {
        return;
    }
    let next = positions.iter().copied().filter(|&p| p > removed).min();
    if let Some(next) = next {
        let join = |old: &str| format!("{kept}{}", without_leading_blank_lines(old));
        if rewrite_prefix_at(doc.as_table_mut(), next, &join) {
            return;
        }
    }
    if !kept.is_empty() {
        // `kept` の終わりの空の行は、後ろに何も無いので落とす
        let kept = kept.trim_end_matches(|c: char| c.is_whitespace());
        let trailing = doc.trailing().as_str().unwrap_or("").to_string();
        doc.set_trailing(format!("{kept}\n{trailing}"));
    }
}

/// 場所が `position` の表の、見出しの前に書いてあるものを `f` で書き換える。見つけたら true。
fn rewrite_prefix_at(table: &mut Table, position: isize, f: &dyn Fn(&str) -> String) -> bool {
    let rewrite = |t: &mut Table| {
        let new = f(t.decor().prefix().and_then(|p| p.as_str()).unwrap_or(""));
        t.decor_mut().set_prefix(new);
    };
    for (_, item) in table.iter_mut() {
        match item {
            Item::Table(t) => {
                if !t.is_implicit() && !t.is_dotted() && t.position() == Some(position) {
                    rewrite(t);
                    return true;
                }
                if rewrite_prefix_at(t, position, f) {
                    return true;
                }
            }
            Item::ArrayOfTables(a) => {
                for t in a.iter_mut() {
                    if t.position() == Some(position) {
                        rewrite(t);
                        return true;
                    }
                    if rewrite_prefix_at(t, position, f) {
                        return true;
                    }
                }
            }
            _ => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kisui-list-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// TOML の表（テストで項目を書く）。
    fn table(text: &str) -> toml::Table {
        text.parse().unwrap()
    }

    fn add(text: &str) -> Edit {
        Edit::Add(table(text))
    }

    fn update(key: &str, set: &str, unset: &[&str]) -> Edit {
        Edit::Update {
            key: key.into(),
            set: table(set),
            unset: unset.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn remove(key: &str) -> Edit {
        Edit::Remove { key: key.into() }
    }

    /// `text` に `e` を行ったあとの中身（確かめは通す）。
    fn after(list: &List, text: &str, e: Edit) -> Result<String, EditError> {
        let mut doc: DocumentMut = text.parse().unwrap();
        apply(&mut doc, list, e).map(|()| doc.to_string())
    }

    fn machines(text: &str, e: Edit) -> String {
        after(&MACHINES, text, e).unwrap()
    }

    // 足す：一覧が無ければ作る。あれば後ろに足す。ほかの表・コメント・並びはそのまま
    #[test]
    fn add_appends_and_keeps_the_rest() {
        // 空のファイル
        assert_eq!(
            machines("", add("name = \"dev\"\nssh = \"dev-vm\"")),
            "[[gui.machines]]\nssh = \"dev-vm\"\nname = \"dev\"\n"
        );
        // ほかの表だけのファイル。前との間を 1 行空ける
        let src = "# 自分の設定\nui-language = \"ja\" # 言葉\n\n[server]\nidle_stop_days = 1\n";
        assert_eq!(
            machines(src, add("ssh = \"a\"")),
            format!("{src}\n[[gui.machines]]\nssh = \"a\"\n")
        );
        // [gui] の中身と [gui.browser] は残し、一覧は [gui] の表の並びに続ける
        let src = "[gui]\nmascot = \"neko\" # キャラクター\n\n[gui.browser]\nenabled = true\n\n[server]\nidle_stop_days = 1\n";
        assert_eq!(
            machines(src, add("ssh = \"a\"")),
            "[gui]\nmascot = \"neko\" # キャラクター\n\n[gui.browser]\nenabled = true\n\n[[gui.machines]]\nssh = \"a\"\n\n[server]\nidle_stop_days = 1\n"
        );
        // 一覧があれば、その後ろ（ほかの表の前）に足す。前の項目のコメントも残る
        let src =
            "[[gui.machines]]\nssh = \"a\" # 1 台目\n\n# サーバー\n[server]\nidle_stop_days = 1\n";
        assert_eq!(
            machines(src, add("ssh = \"b\"\nname = \"bee\"")),
            "[[gui.machines]]\nssh = \"a\" # 1 台目\n\n[[gui.machines]]\nssh = \"b\"\nname = \"bee\"\n\n# サーバー\n[server]\nidle_stop_days = 1\n"
        );
        // 空の配列（machines = []）にも、書いた人の形（1 行の配列）のまま足す。行の終わりのコメントも残る
        assert_eq!(
            machines(
                "[gui]\nmachines = [] # 今は無し\nmascot = \"neko\"\n",
                add("ssh = \"a\"")
            ),
            "[gui]\nmachines = [{ ssh = \"a\" }] # 今は無し\nmascot = \"neko\"\n"
        );
        // 1 行の配列で書いた一覧には、同じ形で足す
        assert_eq!(
            machines(
                "[gui]\nmachines = [{ ssh = \"a\" }] # 手で書いた\n",
                add("ssh = \"b\"\nname = \"bee\"")
            ),
            "[gui]\nmachines = [{ ssh = \"a\" }, { ssh = \"b\", name = \"bee\" }] # 手で書いた\n"
        );
        // 同じキーの項目があれば断る（前後の空白は除いて比べる）
        assert_eq!(
            after(
                &MACHINES,
                "[[gui.machines]]\nssh = \"a\"\n",
                add("ssh = \" a \"")
            ),
            Err(EditError::Exists("a".into()))
        );
        // 見分けるキーの無い項目・文字列でないキーは断る
        for bad in ["name = \"x\"", "ssh = 1", "ssh = \" \""] {
            assert!(
                matches!(after(&MACHINES, "", add(bad)), Err(EditError::Entry(_))),
                "{bad}"
            );
        }
    }

    // 変える：渡したキーだけを書き換える。渡していないキー・コメント・ほかの項目は残す
    #[test]
    fn update_sets_only_the_given_keys() {
        let src = "# 頭\n[[gui.machines]]\nssh = \"a\"\nname = \"old\" # 名前\nstart_dir = \"~/src\"\n\n[[gui.machines]]\nssh = \"b\"\n";
        assert_eq!(
            machines(src, update("a", "name = \"new\"", &[])),
            src.replace("\"old\"", "\"new\"")
        );
        // 無かったキーは足し、unset のキーは消す
        assert_eq!(
            machines(src, update("b", "name = \"bee\"", &[])),
            format!("{src}name = \"bee\"\n")
        );
        assert_eq!(
            machines(src, update("a", "", &["name", "none"])),
            src.replace("name = \"old\" # 名前\n", "")
        );
        // 見分けるキーも変えられる。ほかの項目と重なれば断る
        assert_eq!(
            machines(src, update("a", "ssh = \"c\"", &[])),
            src.replace("ssh = \"a\"", "ssh = \"c\"")
        );
        assert_eq!(
            after(&MACHINES, src, update("a", "ssh = \"b\"", &[])),
            Err(EditError::Exists("b".into()))
        );
        // 自分と同じキーに「変える」のはよい
        assert_eq!(machines(src, update("a", "ssh = \"a\"", &[])), src);
        // 無い項目・見分けるキーを消す
        assert_eq!(
            after(&MACHINES, src, update("z", "name = \"x\"", &[])),
            Err(EditError::Missing("z".into()))
        );
        assert!(matches!(
            after(&MACHINES, src, update("a", "", &["ssh"])),
            Err(EditError::Entry(_))
        ));
        // 1 行の配列の項目
        assert_eq!(
            machines(
                "gui.machines = [{ ssh = \"a\", name = \"old\" }, { ssh = \"b\" }]\n",
                update("a", "name = \"new\"", &[])
            ),
            "gui.machines = [{ ssh = \"a\", name = \"new\" }, { ssh = \"b\" }]\n"
        );
    }

    // 消す：その項目だけを消す。最後の 1 件を消したら、一覧ごと無くす
    #[test]
    fn remove_takes_one_entry() {
        let src = "[[gui.machines]]\nssh = \"a\"\n\n[[gui.machines]]\nssh = \"b\"\nname = \"bee\"\n\n[server]\nidle_stop_days = 1\n";
        assert_eq!(
            machines(src, remove("b")),
            "[[gui.machines]]\nssh = \"a\"\n\n[server]\nidle_stop_days = 1\n"
        );
        assert_eq!(
            machines(src, remove("a")),
            "[[gui.machines]]\nssh = \"b\"\nname = \"bee\"\n\n[server]\nidle_stop_days = 1\n"
        );
        let one = machines(src, remove("a"));
        assert_eq!(
            machines(&one, remove("b")),
            "[server]\nidle_stop_days = 1\n"
        );
        // 表に入らない項目が前にあれば、間の空の行は残す
        assert_eq!(
            machines(
                "ui-language = \"ja\"\n\n[[gui.machines]]\nssh = \"a\"\n\n[server]\nidle_stop_days = 1\n",
                remove("a")
            ),
            "ui-language = \"ja\"\n\n[server]\nidle_stop_days = 1\n"
        );
        // 無い項目（config.toml にだけあるマシンも、ここでは無い項目）
        assert_eq!(
            after(&MACHINES, src, remove("z")),
            Err(EditError::Missing("z".into()))
        );
        assert_eq!(
            after(&MACHINES, "[server]\nidle_stop_days = 1\n", remove("a")),
            Err(EditError::Missing("a".into()))
        );
        // 1 行の配列の項目
        assert_eq!(
            machines(
                "gui.machines = [{ ssh = \"a\" }, { ssh = \"b\" }]\n",
                remove("a")
            ),
            "gui.machines = [{ ssh = \"b\" }]\n"
        );
        // 行を分けて書いた配列。最後の 1 件を消しても、空の配列は残す
        let src = "[gui]\nmachines = [\n  { ssh = \"a\" },\n  { ssh = \"b\" },\n]\n";
        assert_eq!(
            machines(src, remove("a")),
            "[gui]\nmachines = [\n  { ssh = \"b\" },\n]\n"
        );
        assert_eq!(
            machines(&machines(src, remove("a")), remove("b")),
            "[gui]\nmachines = [\n]\n"
        );
    }

    // 消す項目の見出しのすぐ上のコメントは一緒に消し、空の行で離したコメント（ファイルの頭の説明など）は残す
    #[test]
    fn remove_keeps_comments_apart_from_the_entry() {
        let src = "# このファイルは手元だけの設定\n\n# 開発のマシン\n[[gui.machines]]\nssh = \"a\"\n\n[[gui.machines]]\nssh = \"b\"\n";
        assert_eq!(
            machines(src, remove("a")),
            "# このファイルは手元だけの設定\n\n[[gui.machines]]\nssh = \"b\"\n"
        );
        // 次の表が無ければ、ファイルの終わりに残す
        let one = "# このファイルは手元だけの設定\n\n[[gui.machines]]\nssh = \"a\"\n";
        assert_eq!(
            machines(one, remove("a")),
            "# このファイルは手元だけの設定\n"
        );
        // 次に来るのがほかの表でも、その前に残す
        let src = "[server]\nidle_stop_days = 1\n\n# ここからマシン\n\n[[gui.machines]]\nssh = \"a\"\n\n[db.permissions.r]\nrun = \"read\"\n";
        assert_eq!(
            machines(src, remove("a")),
            "[server]\nidle_stop_days = 1\n\n# ここからマシン\n\n[db.permissions.r]\nrun = \"read\"\n"
        );
    }

    // DB の接続：名前で見分ける。variants は [[db.connections.variants]] の形で書く
    #[test]
    fn db_connections_by_name() {
        let out = after(
            &DB_CONNECTIONS,
            "[db.permissions.r]\nrun = \"read\"\n",
            add("kind = \"postgres\"\nname = \"shop\"\nport = 5433\nread-only = true\nuser = \"app\"\n[[variants]]\nname = \"dev\"\nhost = \"dev.example.com\"\n[[variants]]\nname = \"prod\"\nhost = \"db.example.com\""),
        )
        .unwrap();
        assert_eq!(
            out,
            "[db.permissions.r]\nrun = \"read\"\n\n[[db.connections]]\nname = \"shop\"\nkind = \"postgres\"\nport = 5433\nread-only = true\nuser = \"app\"\n\n[[db.connections.variants]]\nhost = \"dev.example.com\"\nname = \"dev\"\n\n[[db.connections.variants]]\nhost = \"db.example.com\"\nname = \"prod\"\n"
        );
        // 読み直しても同じ値
        let read: toml::Table = out.parse().unwrap();
        let conn = &read["db"]["connections"][0];
        assert_eq!(conn["port"].as_integer(), Some(5433));
        assert_eq!(conn["read-only"].as_bool(), Some(true));
        assert_eq!(conn["variants"][1]["name"].as_str(), Some("prod"));
        // 名前を変える・キーを消す。variants は触らない
        let out2 = after(
            &DB_CONNECTIONS,
            &out,
            update("shop", "name = \"store\"\nport = 5434", &["read-only"]),
        )
        .unwrap();
        assert_eq!(
            out2,
            out.replace("\"shop\"", "\"store\"")
                .replace("5433", "5434")
                .replace("read-only = true\n", "")
        );
        assert_eq!(
            after(&DB_CONNECTIONS, &out2, remove("store")).unwrap(),
            "[db.permissions.r]\nrun = \"read\"\n"
        );
    }

    // 配下の表（variants）を持つ 1 件を消しても、残すコメントは次の表の前に残り、ファイルは空の行で始まらない
    #[test]
    fn remove_entry_with_nested_tables() {
        let entry = "[[db.connections]]\nname = \"a\"\n[[db.connections.variants]]\nname = \"dev\"\n\n[[db.connections.variants]]\nname = \"prod\"\n";
        let rest = "[[db.connections]]\nname = \"b\"\n";
        let rm = |src: &str| after(&DB_CONNECTIONS, src, remove("a")).unwrap();
        assert_eq!(
            rm(&format!("# header\n\n{entry}\n{rest}")),
            format!("# header\n\n{rest}")
        );
        // コメントの無いファイルの頭の 1 件
        assert_eq!(rm(&format!("{entry}\n{rest}")), rest);
        // 次の表が無ければ、コメントはファイルの終わりに残る
        assert_eq!(rm(&format!("# header\n\n{entry}")), "# header\n");
    }

    // コメントだけのファイルに足すと、コメントは足した 1 件の上に残る。「消す → 足す」で元の中身に戻る
    #[test]
    fn add_to_a_file_of_comments_only() {
        let src = "# 手元だけの設定\n\n[[gui.machines]]\nssh = \"a\"\n";
        assert_eq!(machines("# 手元だけの設定\n", add("ssh = \"a\"")), src);
        let emptied = machines(src, remove("a"));
        assert_eq!(emptied, "# 手元だけの設定\n");
        assert_eq!(machines(&emptied, add("ssh = \"a\"")), src);
        // 空の行だけのファイルは、空のファイルと同じ
        assert_eq!(
            machines("\n\n", add("ssh = \"a\"")),
            "[[gui.machines]]\nssh = \"a\"\n"
        );
    }

    // 一覧の形でないものには書かない
    #[test]
    fn wrong_shapes_are_refused() {
        for src in [
            "gui = 1\n",
            "[gui]\nmachines = 1\n",
            "[gui]\nmachines = [1]\n",
            "[gui.machines]\nssh = \"a\"\n",
        ] {
            for e in [add("ssh = \"b\""), remove("a")] {
                assert!(
                    matches!(after(&MACHINES, src, e), Err(EditError::File(_))),
                    "{src}"
                );
            }
        }
    }

    // ファイルに書く：config.local.toml だけに書き、config.toml は触らない。確かめを通らなければ書かない
    #[test]
    fn edit_machines_writes_config_local_only() {
        use crate::config::load_gui;
        let d = temp_dir("edit");
        let base = "[[gui.machines]]\nssh = \"a\"\nname = \"x\"\n";
        fs::write(d.join("config.toml"), base).unwrap();
        let local = d.join("config.local.toml");
        let ssh_of = || -> Vec<(String, bool)> {
            load_gui(&d)
                .unwrap()
                .machines
                .into_iter()
                .map(|m| (m.ssh, m.local))
                .collect()
        };
        // ファイルが無ければ作る
        edit_machines(&d, add("ssh = \"b\"")).unwrap();
        assert_eq!(
            fs::read_to_string(&local).unwrap(),
            "[[gui.machines]]\nssh = \"b\"\n"
        );
        assert_eq!(ssh_of(), [("a".into(), false), ("b".into(), true)]);
        // 確かめを通らない書き込みは、ファイルを変えない：使えない行き先、config.toml のマシンと同じ名前
        for bad in [
            add("ssh = \"-oProxyCommand\""),
            add("ssh = \"c\"\nname = \"x\""),
            update("b", "name = \"x\"", &[]),
        ] {
            assert!(matches!(
                edit_machines(&d, bad),
                Err(EditError::Rejected(_))
            ));
        }
        assert_eq!(
            fs::read_to_string(&local).unwrap(),
            "[[gui.machines]]\nssh = \"b\"\n"
        );
        // config.toml のマシンは、変えられず、消せない（config.local.toml に無い）
        assert_eq!(
            edit_machines(&d, update("a", "name = \"y\"", &[])),
            Err(EditError::Missing("a".into()))
        );
        assert_eq!(
            edit_machines(&d, remove("a")),
            Err(EditError::Missing("a".into()))
        );
        // 同じ行き先を足すと、config.toml の項目に代わる
        edit_machines(&d, add("ssh = \"a\"\nname = \"mine\"")).unwrap();
        assert_eq!(ssh_of(), [("a".into(), true), ("b".into(), true)]);
        // 消すと、config.toml の項目に戻る
        edit_machines(&d, remove("a")).unwrap();
        edit_machines(&d, remove("b")).unwrap();
        assert_eq!(ssh_of(), [("a".into(), false)]);
        assert_eq!(fs::read_to_string(&local).unwrap(), "");
        assert_eq!(fs::read_to_string(d.join("config.toml")).unwrap(), base);
        // 壊れたファイルは上書きしない
        fs::write(&local, "[gui\n").unwrap();
        let e = edit_machines(&d, add("ssh = \"b\"")).unwrap_err();
        assert!(
            matches!(&e, EditError::File(s) if s.contains("config.local.toml")),
            "{e}"
        );
        assert_eq!(fs::read_to_string(&local).unwrap(), "[gui\n");
        // 一覧の形でないときの理由は、ファイルの場所を含む
        fs::write(&local, "[gui]\nmachines = 1\n").unwrap();
        let e = edit_machines(&d, add("ssh = \"b\"")).unwrap_err();
        assert!(
            matches!(&e, EditError::File(s) if s.contains("config.local.toml") && s.contains("gui.machines")),
            "{e}"
        );
        // DB の接続は、渡した確かめを通す
        fs::write(&local, "").unwrap();
        let e = edit(&d, &DB_CONNECTIONS, add("name = \"shop\""), |_| {
            Err("kind がありません".into())
        });
        assert_eq!(e, Err(EditError::Rejected("kind がありません".into())));
        assert_eq!(fs::read_to_string(&local).unwrap(), "");
        edit(&d, &DB_CONNECTIONS, add("name = \"shop\""), |text| {
            assert_eq!(text, "[[db.connections]]\nname = \"shop\"\n");
            Ok(())
        })
        .unwrap();
        let _ = fs::remove_dir_all(&d);
    }

    // 窓のマシンの書き込み：足す・名前を変える・外すを config.local.toml に書き、重ねたあとの一覧を返す
    #[test]
    fn edit_machine_from_the_window() {
        let d = temp_dir("window");
        fs::write(d.join("config.toml"), "[[gui.machines]]\nssh = \"a\"\n").unwrap();
        let local = d.join("config.local.toml");
        let row = |ssh: &str, name: Option<&str>, local: bool| ConfigMachine {
            ssh: ssh.into(),
            name: name.map(Into::into),
            local,
        };
        let got = edit_machine(
            &d,
            MachineEdit::Add {
                ssh: " b ".into(),
                name: Some(" bee ".into()),
            },
        )
        .unwrap();
        assert_eq!(got, [row("a", None, false), row("b", Some("bee"), true)]);
        // 名前の無いマシンは name を書かない
        edit_machine(
            &d,
            MachineEdit::Add {
                ssh: "c".into(),
                name: Some("  ".into()),
            },
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(&local).unwrap(),
            "[[gui.machines]]\nssh = \"b\"\nname = \"bee\"\n\n[[gui.machines]]\nssh = \"c\"\n"
        );
        // 名前を変える。空にすると name を消す
        edit_machine(
            &d,
            MachineEdit::Rename {
                ssh: "c".into(),
                name: Some("sea".into()),
            },
        )
        .unwrap();
        let got = edit_machine(
            &d,
            MachineEdit::Rename {
                ssh: "b".into(),
                name: None,
            },
        )
        .unwrap();
        assert_eq!(
            got,
            [
                row("a", None, false),
                row("b", None, true),
                row("c", Some("sea"), true)
            ]
        );
        // config.toml のマシンは変えられない
        assert_eq!(
            edit_machine(
                &d,
                MachineEdit::Rename {
                    ssh: "a".into(),
                    name: Some("x".into())
                }
            ),
            Err(EditError::Missing("a".into()))
        );
        // 外す
        let got = edit_machine(&d, MachineEdit::Remove { ssh: "b".into() }).unwrap();
        assert_eq!(got, [row("a", None, false), row("c", Some("sea"), true)]);
        assert_eq!(
            fs::read_to_string(&local).unwrap(),
            "[[gui.machines]]\nssh = \"c\"\nname = \"sea\"\n"
        );
        let _ = fs::remove_dir_all(&d);
    }

    // 画面が受ける形
    #[test]
    fn machine_edit_and_error_wire_format() {
        let e: MachineEdit =
            serde_json::from_str(r#"{"kind":"add","ssh":"a","name":null}"#).unwrap();
        assert_eq!(
            e,
            MachineEdit::Add {
                ssh: "a".into(),
                name: None
            }
        );
        let e: MachineEdit = serde_json::from_str(r#"{"kind":"remove","ssh":"a"}"#).unwrap();
        assert_eq!(e, MachineEdit::Remove { ssh: "a".into() });
        assert_eq!(
            serde_json::to_string(&EditError::Missing("a".into())).unwrap(),
            r#"{"kind":"missing","detail":"a"}"#
        );
    }
}
