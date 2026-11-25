//! 手元の設定ファイルの `[[gui.machines]]` と `[gui.browser]`。
//!
//! 読むのは設定のフォルダの `config.toml` と `config.local.toml` の 2 つ。`config.toml` が土台で、
//! `config.local.toml` を上に重ねる（kisui の `config/config.go` と同じファイルを同じ順で読む）。
//! `[[gui.machines]]` の一覧は、項目（マシン）ごとに重ねる。ssh の行き先（`ssh`）が同じ項目が両方にあれば、`config.local.toml` の項目が
//! `config.toml` の項目に丸ごと代わる（項目の中のキーごとには重ねない。`config.toml` にだけ書いた `name` は引き継がない）。
//! 片方にしかない項目は、どちらも残る。並びは `config.toml` の順で、そのあとに `config.local.toml` にだけある項目が続く。
//! 窓が `config.local.toml` に 1 件足しても、`config.toml` の一覧が隠れないようにするため（kisui の `config/db.go` の `[[db.connections]]` も、
//! 名前（`name`）ごとに同じように重ねる）。
//! `config.local.toml` の空の一覧（`[gui] machines = []`）は、何も足さず、何も消さない。`config.toml` の項目を `config.local.toml` から消す書き方は無い。
//! 重ねたあとの一覧で名前が重なったら、間違いにする（`config.local.toml` の行を指す）。どちらのファイルも無くてよい。
//! `[gui.browser] enabled`（内蔵ブラウザのタブを使うか。#202）は、書いてあるファイルのものを使い、両方にあれば `config.local.toml` が勝つ。
//! どちらにも無ければ使わない。
//! `[gui.browser] passkey_sites`（パスキーのときに外のブラウザ（Firefox）へ移り、Cookie を写して戻ってよいサイト。#206）も、
//! `enabled` と同じく、書いてあるファイルのものを使い、両方にあれば `config.local.toml` が勝つ。
//! 前の版の `passkey_browser`（移る先のブラウザを選んだ。#433 で Firefox だけにして外した）は、ほかの知らない項目と同じく読み飛ばす。
//! `passkey_sites` に `.google.com`（先頭に `.`）の書き方で公開サフィックス（`.com`・`.github.io`）を書いた項目は、間違いにせず使わない
//! （`passkey_rejected` に入れ、画面がお知らせに出す。ほかの項目は使う）。
//! `[gui.sidebar] tabs-height`（タブの段の高さの上限。サイドバーの高さに対する %。10〜90 の整数。#284）も、書いてあるファイルのものを使い、両方にあれば `config.local.toml` が勝つ。
//! `[gui.shortcuts]`（近道。`"Ctrl+Shift+N" = "workspace.new"` のように、キー = コマンドの名前）は、キーごとに重ね、同じキーは `config.local.toml` が勝つ。
//! キーの書き方とコマンドの名前が使えるかは、画面側が確かめる（間違いはお知らせに出し、起動は止めない）。
//! 窓が設定を書くときは `config.local.toml` に書く（`config.toml` は home-manager が読み取り専用で置くことがある）。
//! GUI が読むのはこの節と `[gui] mascot`（リーダーの案内を運ぶキャラクターの名前。mascot.rs）だけ。ほかの節（`kisui serve` の `[server]` など）は kisui が読む。
//! 知らない項目は間違いにしない（新しい版用に書いた項目があっても起動する）。読み飛ばす。
//! 間違い（TOML の書き方・型の違い・使えない ssh の行き先・重なり）は、
//! 「ファイル:行: 理由」の 1 行の文字列にして返す（2 つのファイルにあれば改行でつなぐ）。画面側はそれを出して、ほかは何もしない（起動しない）。
//! 置き場は `$XDG_CONFIG_HOME` が絶対パスならそれ、なければ `~/.config` の下の `kisui-terminal/`
//! （nightly の GUI は `kisui-terminal-nightly/`、そのフォルダが無ければ `kisui-terminal/`）。
//! shijimi-editor の設定のフォルダ（`shijimi-editor/`）は読まない。

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use toml::Spanned;

use crate::connection::valid_host;

/// 設定ファイルに書いたマシン 1 台。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConfigMachine {
    /// ssh の行き先
    pub ssh: String,
    /// サイドバーに出す名前。省くと ssh の行き先
    pub name: Option<String>,
    /// `config.local.toml` の項目か（両方のファイルにあれば true。`config.local.toml` の項目が代わっている）。
    /// 窓が書き換えられるのは、これが true のマシンだけ（`config.toml` には書かない）
    pub local: bool,
}

/// 1 つのファイルから読んだマシン 1 台と、間違いを指すための場所。
struct ParsedMachine {
    ssh: String,
    name: Option<String>,
    /// 一覧の中の番号（0 始まり）
    index: usize,
    /// 名前（無ければ ssh の行き先）を書いた行
    line: usize,
}

impl ParsedMachine {
    /// 出す名前（付けた名前、無ければ ssh の行き先）。
    fn label(&self) -> &str {
        self.name.as_deref().unwrap_or(&self.ssh)
    }
}

#[derive(Deserialize)]
struct File {
    // ほかの節は kisui（`[server]`）などが読む
    gui: Option<Gui>,
}

#[derive(Deserialize)]
struct Gui {
    machines: Option<Vec<Entry>>,
    /// 内蔵ブラウザ（#202）
    browser: Option<Browser>,
    /// 近道（キー = コマンドの名前）
    shortcuts: Option<BTreeMap<String, String>>,
    /// サイドバー（#284）
    sidebar: Option<Sidebar>,
}

/// `[gui.sidebar]`。
#[derive(Deserialize)]
struct Sidebar {
    /// shj が動いているときの、タブの段の高さの上限（サイドバーの高さに対する %）。書いていなければ画面の元の値（40）
    #[serde(rename = "tabs-height")]
    tabs_height: Option<Spanned<i64>>,
}

/// `[gui.sidebar] tabs-height` に書ける範囲（%）。app/src/ui/main-window/panes.ts の LIMITS.tabs と同じ。
const TABS_HEIGHT_RANGE: std::ops::RangeInclusive<i64> = 10..=90;

/// `[gui.browser]`。
#[derive(Deserialize)]
struct Browser {
    /// 内蔵ブラウザのタブを使うか。書いていなければ使わない。config.local.toml に書けば、config.toml のものより勝つ
    enabled: Option<bool>,
    /// パスキーのときに外のブラウザへ移り、Cookie を写して戻ってよいサイト（host。#206）
    passkey_sites: Option<Vec<Spanned<String>>>,
}

/// 設定ファイルの GUI の節（`[gui]`）のうち、画面が使うもの。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct GuiConfig {
    pub machines: Vec<ConfigMachine>,
    /// 内蔵ブラウザのタブを使うか（`[gui.browser] enabled`。初めは使わない）
    pub browser: bool,
    /// パスキーのときに外のブラウザへ移ってよいサイト（`[gui.browser] passkey_sites`。殻だけが使う）
    #[serde(skip)]
    pub passkey_sites: Vec<String>,
    /// `passkey_sites` に書いたが、公開サフィックスなので使わない項目（`.com` など。書いた形のまま。画面がお知らせに出す）
    #[serde(rename = "passkeyRejected")]
    pub passkey_rejected: Vec<String>,
    /// 設定で足した近道（`[gui.shortcuts]`。キーの順）
    pub shortcuts: Vec<ConfigShortcut>,
    /// タブの段の高さの上限の元の値（`[gui.sidebar] tabs-height`。サイドバーの高さに対する %）。書いていなければ None（画面が 40 にする）
    #[serde(rename = "sidebarTabsHeight")]
    pub sidebar_tabs_height: Option<u8>,
}

/// 設定ファイルに書いた近道 1 つ。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConfigShortcut {
    /// キー（`Ctrl+Shift+N` など。書き方は画面側が読む）
    pub key: String,
    /// コマンドの名前（`workspace.new`、引数があれば `pane.focus:right`、既定の近道を消すなら `none`）
    pub command: String,
    /// どのファイルに書いたか（0 が `config.toml`、1 が `config.local.toml`）。同じキーを別の書き方（大文字小文字など）で両方に書いたとき、画面が後のものを勝たせる
    pub source: u8,
}

/// 1 つのファイルから読んだもの（書いていない項目は None）。
#[derive(Default)]
struct Parsed {
    machines: Option<Vec<ParsedMachine>>,
    browser: Option<bool>,
    passkey_sites: Option<PasskeySites>,
    shortcuts: Option<BTreeMap<String, String>>,
    sidebar_tabs_height: Option<u8>,
}

/// 1 つのファイルの `[gui.browser] passkey_sites`（`check_sites` が分けたもの）。
struct PasskeySites {
    /// 使う項目
    used: Vec<String>,
    /// 公開サフィックスなので使わない項目
    rejected: Vec<String>,
}

#[derive(Deserialize)]
struct Entry {
    ssh: Spanned<String>,
    name: Option<Spanned<String>>,
}

/// 「ローカル」の名前（画面の言葉ごとの、GUI の localLabel。どちらの名前のマシンも出せない）。
const LOCAL_LABELS: [&str; 2] = ["Local", "ローカル"];

/// 設定のフォルダで読むファイル。重ねる順（後のものが勝つ）。
const FILES: [&str; 2] = ["config.toml", "config.local.toml"];

/// 設定の置き場所の土台（`$XDG_CONFIG_HOME` が絶対パスならそれ、なければ `~/.config`）。
fn base_dir(config_home: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    Some(match config_home {
        Some(d) if d.is_absolute() => d.to_path_buf(),
        _ => home?.join(".config"),
    })
}

/// `name` の設定フォルダ。nightly は `<name>-nightly`、無ければ `name`。
fn dir_of(base: &Path, name: &str, nightly: bool) -> PathBuf {
    if nightly {
        let n = base.join(format!("{name}-nightly"));
        if n.is_dir() {
            return n;
        }
    }
    base.join(name)
}

/// 設定のフォルダ（kisui-terminal 自身のもの）。`config_home` は `$XDG_CONFIG_HOME`（絶対パスのときだけ使う）、`home` は `$HOME`。
pub fn config_dir(
    config_home: Option<&Path>,
    home: Option<&Path>,
    nightly: bool,
) -> Option<PathBuf> {
    let base = base_dir(config_home, home)?;
    Some(dir_of(&base, "kisui-terminal", nightly))
}

/// 環境（`$XDG_CONFIG_HOME`・`$HOME`・nightly か）。
pub(crate) fn env() -> (Option<PathBuf>, Option<PathBuf>, bool) {
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let nightly = matches!(
        crate::locate::split_version(crate::version::get()),
        Some((_, Some(_)))
    );
    (xdg, home, nightly)
}

/// 環境から設定のフォルダを決めて読む。
pub fn load_default() -> Result<GuiConfig, String> {
    let (xdg, home, nightly) = env();
    match config_dir(xdg.as_deref(), home.as_deref(), nightly) {
        Some(d) => load_gui(&d),
        None => Ok(GuiConfig::default()),
    }
}

/// 設定のフォルダの 2 つのファイルを読んで重ねる。どちらかに間違いがあれば、全部の間違いを改行でつないで返す。
pub fn load_gui(dir: &Path) -> Result<GuiConfig, String> {
    overlay(dir, FILES.map(|name| load(&dir.join(name))))
}

/// `config.local.toml` の中身を `local_text` にしたら、設定が間違いなく読めるか。窓が `config.local.toml` を書く前に確かめる
/// （間違いのある設定を書くと、次の起動で窓が出ない）。`config.toml` は今あるものを読む。
pub(crate) fn check_local(dir: &Path, local_text: &str) -> Result<(), String> {
    let [base, local] = FILES;
    overlay(
        dir,
        [
            load(&dir.join(base)),
            parse_at(&dir.join(local), local_text),
        ],
    )
    .map(|_| ())
}

/// 2 つのファイルから読んだもの（`FILES` の順）を重ねる。
fn overlay(dir: &Path, files: [Result<Parsed, String>; 2]) -> Result<GuiConfig, String> {
    let mut out = GuiConfig::default();
    let mut errs = Vec::new();
    let mut shortcuts: BTreeMap<String, (String, u8)> = BTreeMap::new();
    for (source, (name, file)) in FILES.into_iter().zip(files).enumerate() {
        match file {
            Ok(p) => {
                // マシンの一覧は ssh の行き先ごとに重ねる（同じ行き先は後のファイルの項目が代わる）
                if let Some(m) = p.machines {
                    if let Err(e) =
                        overlay_machines(&mut out.machines, m, name == FILES[1], &dir.join(name))
                    {
                        errs.push(e);
                    }
                }
                // 書いてあるファイルが、前のファイルのものに勝つ
                if let Some(b) = p.browser {
                    out.browser = b;
                }
                if let Some(s) = p.passkey_sites {
                    out.passkey_sites = s.used;
                    out.passkey_rejected = s.rejected;
                }
                if let Some(h) = p.sidebar_tabs_height {
                    out.sidebar_tabs_height = Some(h);
                }
                // 近道はキーごとに重ねる（同じキーは後のファイルが勝つ）
                if let Some(m) = p.shortcuts {
                    shortcuts.extend(m.into_iter().map(|(k, c)| (k, (c, source as u8))));
                }
            }
            Err(e) => errs.push(e),
        }
    }
    out.shortcuts = shortcuts
        .into_iter()
        .map(|(key, (command, source))| ConfigShortcut {
            key,
            command,
            source,
        })
        .collect();
    if errs.is_empty() {
        Ok(out)
    } else {
        Err(errs.join("\n"))
    }
}

/// 前のファイルまでのマシンの一覧 `base` に、`path` のファイル（`local`：`config.local.toml` か）の一覧 `over` を重ねる。
/// ssh の行き先が同じ項目は、その場所で `over` の項目に代える。`base` に無い項目は、後ろに足す。
/// 重ねたあとに名前が重なったら Err（`over` の項目の行を指す。1 つのファイルの中の重なりは `check_machines` が先に断っている）。
fn overlay_machines(
    base: &mut Vec<ConfigMachine>,
    over: Vec<ParsedMachine>,
    local: bool,
    path: &Path,
) -> Result<(), String> {
    for m in &over {
        let machine = ConfigMachine {
            ssh: m.ssh.clone(),
            name: m.name.clone(),
            local,
        };
        match base.iter_mut().find(|b| b.ssh == m.ssh) {
            Some(b) => *b = machine,
            None => base.push(machine),
        }
    }
    for m in &over {
        let taken = base
            .iter()
            .any(|b| b.ssh != m.ssh && b.name.as_deref().unwrap_or(&b.ssh) == m.label());
        if taken {
            return Err(format!(
                "{}:{}: gui.machines[{}]: 名前 {} は {} のマシンで使っています",
                path.display(),
                m.line,
                m.index,
                m.label(),
                FILES[0]
            ));
        }
    }
    Ok(())
}

/// `load_gui` のマシンの一覧だけ。
#[cfg(test)]
fn load_dir(dir: &Path) -> Result<Vec<ConfigMachine>, String> {
    load_gui(dir).map(|g| g.machines)
}

/// 設定ファイルを 1 つ読む。無ければ何も書いていないものとする。
fn load(path: &Path) -> Result<Parsed, String> {
    match read_text(path)? {
        Some(text) => parse_at(path, &text),
        None => Ok(Parsed::default()),
    }
}

/// ファイルの中身。無ければ None。
fn read_text(path: &Path) -> Result<Option<String>, String> {
    match fs::read(path) {
        Ok(b) => String::from_utf8(b)
            .map(Some)
            .map_err(|_| format!("{}: UTF-8 で読めません", path.display())),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: 読めません（{e}）", path.display())),
    }
}

/// `path` のファイルの中身 `text` を読む。間違いは「ファイル:行: 理由」にする。
fn parse_at(path: &Path, text: &str) -> Result<Parsed, String> {
    parse_all(text).map_err(|(line, why)| match line {
        Some(l) => format!("{}:{l}: {why}", path.display()),
        None => format!("{}: {why}", path.display()),
    })
}

/// 画面の言葉（`ui-language`。`"en"` か `"ja"`）。kisui（`config/config.go`）と同じ項目で、同じ 2 つのファイルから読む。
/// `config.local.toml` に書いてあれば、そちらが勝つ。書いていない・`"en"` と `"ja"` のどちらでもない値は、英語にする。
/// 読めないファイルや文字列でない値は、書いていないのと同じに扱う（マシンの一覧の間違いとは分ける。間違いは kisui が知らせる）。
pub fn ui_language(dir: &Path) -> &'static str {
    let mut lang = "en";
    for file in FILES {
        let Ok(text) = fs::read_to_string(dir.join(file)) else {
            continue;
        };
        let Ok(table) = text.parse::<toml::Table>() else {
            continue;
        };
        match table.get("ui-language").and_then(|v| v.as_str()) {
            Some("en") => lang = "en",
            Some("ja") => lang = "ja",
            _ => {}
        }
    }
    lang
}

/// 環境から設定のフォルダを決めて、画面の言葉を答える。フォルダが決まらなければ英語。
pub fn ui_language_default() -> &'static str {
    let (xdg, home, nightly) = env();
    match config_dir(xdg.as_deref(), home.as_deref(), nightly) {
        Some(d) => ui_language(&d),
        None => "en",
    }
}

/// `[gui] mascot`（使うキャラクターの名前）。`config.local.toml` に書いてあれば、そちらが勝つ（空の文字列も。キャラクターを出さない）。
/// 書いていなければ None。実験的な機能なので、読めないファイルや文字列でない値は、書いていないのと同じに扱う（マシンの一覧の間違いとは分ける）。
pub fn mascot_name(dir: &Path) -> Option<String> {
    let mut name = None;
    for file in FILES {
        let Ok(text) = fs::read_to_string(dir.join(file)) else {
            continue;
        };
        let Ok(table) = text.parse::<toml::Table>() else {
            continue;
        };
        if let Some(s) = table
            .get("gui")
            .and_then(|g| g.get("mascot"))
            .and_then(|v| v.as_str())
        {
            name = Some(s.to_string());
        }
    }
    name.filter(|n| !n.is_empty())
}

/// 選んだキャラクターの名前を、`config.local.toml` の `[gui] mascot` に書く（`config.toml` には書かない。home-manager が置く
/// 読み取り専用のファイルのことがあるため）。ほかの項目・コメント・並びは変えない。ファイルが無ければ作る。
/// 読めない・TOML として壊れているファイルは、上書きせずに Err を返す。
pub fn write_mascot_name(dir: &Path, name: &str) -> Result<(), String> {
    use toml_edit::{Item, Table, Value};
    edit_local(dir, |doc, path| {
        let gui = doc
            .entry("gui")
            .or_insert_with(|| Item::Table(Table::new()));
        if let Some(t) = gui.as_table_mut() {
            // `[gui.browser]` だけを書いたファイルでは `[gui]` の見出しは省かれているので、`mascot` を書くために出す
            t.set_implicit(false);
        }
        let table = gui
            .as_table_like_mut()
            .ok_or_else(|| format!("{}: [gui] が表ではありません", path.display()))?;
        match table.get_mut("mascot").and_then(|i| i.as_value_mut()) {
            // 前の値の前後の空白と、行末のコメントを残す
            Some(v) => {
                let decor = v.decor().clone();
                let mut nv = Value::from(name);
                *nv.decor_mut() = decor;
                *v = nv;
            }
            None => {
                table.insert("mascot", Item::Value(Value::from(name)));
            }
        }
        Ok(())
    })
}

/// `config.local.toml` を読み、`edit` で書き換えて、書き戻す（窓が設定を書く処理は、どれもここを通す）。
/// `edit` には、読んだ中身（コメント・並びを持ったまま）と、ファイルのパス（間違いの文に使う）を渡す。
/// ファイルが無ければ空の中身から始め、設定のフォルダごと作る。読めない・TOML として壊れているファイルは、上書きせずに Err を返す。
/// `edit` が Err を返したら、何も書かない。
/// 読んでから書くまでの間に、この窓のほかの書き込みが挟まらないよう、1 つずつ行う。
pub(crate) fn edit_local<E: From<String>>(
    dir: &Path,
    edit: impl FnOnce(&mut toml_edit::DocumentMut, &Path) -> Result<(), E>,
) -> Result<(), E> {
    static WRITING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one_at_a_time = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir.join(FILES[1]);
    let text = read_text(&path)?.unwrap_or_default();
    let mut doc: toml_edit::DocumentMut = text
        .parse()
        .map_err(|e| format!("{}: TOML として読めません（{e}）", path.display()))?;
    edit(&mut doc, &path)?;
    fs::create_dir_all(dir).map_err(|e| format!("{}: 作れません（{e}）", dir.display()))?;
    replace_file(&path, doc.to_string().as_bytes())
        .map_err(|e| format!("{}: 書けません（{e}）", path.display()))?;
    Ok(())
}

/// `path` の中身を `bytes` に置き換える。同じフォルダの一時ファイルに書いてから名前を付け替えるので、途中で落ちても、
/// 書きかけを `kisui serve` が読んでも、元の中身か新しい中身のどちらかが見える。
/// `path` がシンボリックリンクなら、リンクの先を置き換える（リンクは外さない）。元の権限は引き継ぐ。
/// 一時ファイルを作れない（フォルダに書けない）ときは、そのまま書き込む。
fn replace_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
        return fs::write(path, bytes);
    };
    let tmp = dir.join(format!(
        ".{}.kisui-{}",
        name.to_string_lossy(),
        std::process::id()
    ));
    // 作るときは持ち主だけが読み書きできる権限で作り、書き終えてから元の権限に揃える（書いている間、ほかのユーザーに読ませない）
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    // 前に落ちて残った一時ファイルがあれば消してから作る
    let _ = fs::remove_file(&tmp);
    let written = opts.open(&tmp).and_then(|mut f| {
        f.write_all(bytes)?;
        if let Ok(m) = fs::metadata(&target) {
            fs::set_permissions(&tmp, m.permissions())?;
        }
        f.sync_all()
    });
    match written.and_then(|()| fs::rename(&tmp, &target)) {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = fs::remove_file(&tmp);
            fs::write(&target, bytes)
        }
    }
}

/// 1 始まりの行番号。
fn line_of(text: &str, offset: usize) -> usize {
    let end = offset.min(text.len());
    text.as_bytes()[..end]
        .iter()
        .filter(|&&b| b == b'\n')
        .count()
        + 1
}

/// 1 つのファイルの `[[gui.machines]]`。書いていなければ None。
#[cfg(test)]
fn parse_file(text: &str) -> Result<Option<Vec<ConfigMachine>>, (Option<usize>, String)> {
    let machines = |list: Vec<ParsedMachine>| {
        list.into_iter()
            .map(|m| ConfigMachine {
                ssh: m.ssh,
                name: m.name,
                local: false,
            })
            .collect()
    };
    parse_all(text).map(|p| p.machines.map(machines))
}

/// 1 つのファイルの `[gui]` の、画面が使う項目。
fn parse_all(text: &str) -> Result<Parsed, (Option<usize>, String)> {
    let file: File = toml::from_str(text).map_err(|e| {
        (
            e.span().map(|s| line_of(text, s.start)),
            e.message().to_string(),
        )
    })?;
    let Some(gui) = file.gui else {
        return Ok(Parsed::default());
    };
    let (browser, passkey_sites) = match gui.browser {
        Some(b) => (
            b.enabled,
            b.passkey_sites.map(|s| check_sites(text, &s)).transpose()?,
        ),
        None => (None, None),
    };
    let shortcuts = gui.shortcuts;
    let sidebar_tabs_height = match gui.sidebar.and_then(|s| s.tabs_height) {
        Some(h) => Some(check_tabs_height(text, &h)?),
        None => None,
    };
    let machines = match gui.machines {
        Some(entries) => Some(check_machines(text, entries)?),
        None => None,
    };
    Ok(Parsed {
        machines,
        browser,
        passkey_sites,
        shortcuts,
        sidebar_tabs_height,
    })
}

/// host の名前として使えるか。小文字の英数字・`-`・`.` だけで、`.` で始まらず終わらず、`..` を含まない。
fn valid_host_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && !s.starts_with('.')
        && !s.ends_with('.')
        && !s.contains("..")
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
}

/// サイトの名前として使えるか。`github.com` のような host（ページの host と完全に同じものに当たる）か、
/// 先頭に `.` を 1 つ付けた `.google.com`（そのドメインとすべてのサブドメインに当たる。passkey.rs の `site_matches`）。
/// scheme・ポート・パス・`*` は書けない。
pub fn valid_site(s: &str) -> bool {
    valid_host_name(s.strip_prefix('.').unwrap_or(s))
}

/// `.google.com` の書き方の項目で、ドメイン（`.` の後ろ）が公開サフィックス（Public Suffix List にあり、誰でもその下に
/// サブドメインを持てる名前。`com`・`co.jp`・`github.io`）か。そう書くと、他人のサイトの Cookie まで写す対象になる。
/// 一覧に無い最上位のドメイン（`internal` など）も、一覧の決まり（`*`）どおり公開サフィックスと見る。
/// 名前そのものは公開サフィックスでなくても、一覧に `*.<名前>` の決まりがあるもの（`kobe.jp`。`x.kobe.jp` はどれも公開サフィックス）も
/// 同じに扱う（その下は他人のサイト）。
/// `github.com` の書き方（host と完全に同じものだけに当たる）は見ない（false）。
pub fn public_suffix_site(s: &str) -> bool {
    let Some(name) = s.strip_prefix('.') else {
        return false;
    };
    let is_suffix = |n: &str| crate::public_suffix::public_suffix(n) == n;
    // 一覧に無い名前を 1 つ下に付けて、`*.<名前>` の決まりに当たるかを見る
    is_suffix(name) || is_suffix(&format!("kisui-terminal-probe.{name}"))
}

/// `[gui.browser] passkey_sites` を確かめる（重なりは 1 つにまとめる）。使う項目と、公開サフィックスなので使わない項目に分ける。
fn check_sites(
    text: &str,
    sites: &[Spanned<String>],
) -> Result<PasskeySites, (Option<usize>, String)> {
    let mut used: Vec<String> = Vec::new();
    let mut rejected: Vec<String> = Vec::new();
    for (i, s) in sites.iter().enumerate() {
        let v = s.get_ref();
        if !valid_site(v) {
            return Err((
                Some(line_of(text, s.span().start)),
                format!(
                    "gui.browser.passkey_sites[{i}]: サイトの名前（github.com のような host か、サブドメインもまとめる .google.com。小文字。https:// やパスは書かない）ではありません"
                ),
            ));
        }
        let to = if public_suffix_site(v) {
            &mut rejected
        } else {
            &mut used
        };
        if !to.contains(v) {
            to.push(v.clone());
        }
    }
    Ok(PasskeySites { used, rejected })
}

/// `[gui.sidebar] tabs-height` を確かめる（範囲外は間違いにする）。
fn check_tabs_height(text: &str, h: &Spanned<i64>) -> Result<u8, (Option<usize>, String)> {
    let v = *h.get_ref();
    if TABS_HEIGHT_RANGE.contains(&v) {
        Ok(v as u8)
    } else {
        Err((
            Some(line_of(text, h.span().start)),
            format!(
                "gui.sidebar.tabs-height: {}〜{} の整数（サイドバーの高さに対する %）を書きます",
                TABS_HEIGHT_RANGE.start(),
                TABS_HEIGHT_RANGE.end()
            ),
        ))
    }
}

/// 1 つのファイルの `[[gui.machines]]` を確かめる（2 つのファイルを重ねたあとの名前の重なりは `overlay_machines` が見る）。
fn check_machines(
    text: &str,
    entries: Vec<Entry>,
) -> Result<Vec<ParsedMachine>, (Option<usize>, String)> {
    let mut out: Vec<ParsedMachine> = Vec::new();
    let mut targets = HashSet::new();
    let mut labels = HashSet::new();
    for (i, e) in entries.into_iter().enumerate() {
        let at = |s: &Spanned<String>| Some(line_of(text, s.span().start));
        let ssh = e.ssh.get_ref().clone();
        if !valid_host(&ssh) {
            return Err((
                at(&e.ssh),
                format!(
                    "gui.machines[{i}].ssh: ssh の行き先に使えません（空・- や @ で始まる・空白や制御文字を含む・長すぎる、のどれか）"
                ),
            ));
        }
        if !targets.insert(ssh.clone()) {
            return Err((
                at(&e.ssh),
                format!("gui.machines[{i}].ssh: {ssh} は前にも書いてあります"),
            ));
        }
        let name = match &e.name {
            None => None,
            Some(n) => {
                let t = n.get_ref().trim();
                if t.is_empty() {
                    return Err((
                        at(n),
                        format!(
                            "gui.machines[{i}].name: 名前が空です（省くと ssh の行き先を出します）"
                        ),
                    ));
                }
                Some(t.to_string())
            }
        };
        let label = name.clone().unwrap_or_else(|| ssh.clone());
        if LOCAL_LABELS.contains(&label.as_str()) || !labels.insert(label.clone()) {
            let n = e.name.as_ref().unwrap_or(&e.ssh);
            return Err((
                at(n),
                format!("gui.machines[{i}]: 名前 {label} はほかのマシンで使っています"),
            ));
        }
        let line = line_of(text, e.name.as_ref().unwrap_or(&e.ssh).span().start);
        out.push(ParsedMachine {
            ssh,
            name,
            index: i,
            line,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1 つのファイルの一覧（書いていなければ空）。
    fn parse(text: &str) -> Result<Vec<ConfigMachine>, (Option<usize>, String)> {
        parse_file(text).map(Option::unwrap_or_default)
    }

    fn err(text: &str) -> (Option<usize>, String) {
        parse(text).unwrap_err()
    }

    #[test]
    fn no_gui_section_is_empty() {
        assert_eq!(parse("theme = \"x\"\n[editor]\nfoo = 1\n").unwrap(), vec![]);
        assert_eq!(parse("").unwrap(), vec![]);
    }

    #[test]
    fn reads_machines_and_ignores_other_sections() {
        let got = parse(
            "theme = \"x\"\n[server]\nidle_stop_days = 1\n\n[[gui.machines]]\nssh = \"dev-vm\"\nname = \"dev\"\n\n[[gui.machines]]\nssh = \"build\"\n",
        )
        .unwrap();
        assert_eq!(
            got,
            vec![
                ConfigMachine {
                    ssh: "dev-vm".into(),
                    name: Some("dev".into()),
                    local: false,
                },
                ConfigMachine {
                    ssh: "build".into(),
                    name: None,
                    local: false,
                },
            ]
        );
    }

    #[test]
    fn syntax_error_has_a_line() {
        let (line, _) = err("a = 1\nb = \n");
        assert!(line.is_some());
    }

    #[test]
    fn wrong_type_has_a_line() {
        let (line, _) = err("[[gui.machines]]\nssh = 1\n");
        assert_eq!(line, Some(2));
    }

    #[test]
    fn unknown_keys_are_skipped() {
        let got = parse("[[gui.machines]]\nssh = \"a\"\nhost = \"b\"\n[gui]\ncolor = 1\n").unwrap();
        assert_eq!(got.len(), 1);
    }

    #[test]
    fn missing_ssh_is_an_error() {
        let (_, why) = err("[[gui.machines]]\nname = \"a\"\n");
        assert!(why.contains("ssh"), "{why}");
    }

    #[test]
    fn bad_target_names_and_repeats() {
        let (line, _) = err("[[gui.machines]]\nssh = \"-oProxy\"\n");
        assert_eq!(line, Some(2));
        let (line, _) = err("[[gui.machines]]\nssh = \"a\"\n[[gui.machines]]\nssh = \"a\"\n");
        assert_eq!(line, Some(4));
        let (line, _) = err("[[gui.machines]]\nssh = \"a\"\nname = \"x\"\n[[gui.machines]]\nssh = \"b\"\nname = \"x\"\n");
        assert_eq!(line, Some(6));
        let (line, _) = err("[[gui.machines]]\nssh = \"a\"\nname = \"ローカル\"\n");
        assert_eq!(line, Some(3));
        let (line, _) = err("[[gui.machines]]\nssh = \"a\"\nname = \"Local\"\n");
        assert_eq!(line, Some(3));
        let (line, _) = err("[[gui.machines]]\nssh = \"a\"\nname = \"  \"\n");
        assert_eq!(line, Some(3));
        // 名前を省いたマシンの行き先と、別のマシンの名前が重なる
        let (line, _) =
            err("[[gui.machines]]\nssh = \"a\"\n[[gui.machines]]\nssh = \"b\"\nname = \"a\"\n");
        assert_eq!(line, Some(5));
    }

    #[test]
    fn path_is_kisui_terminals_own() {
        let home = Path::new("/home/u");
        assert_eq!(
            config_dir(None, Some(home), false).unwrap(),
            Path::new("/home/u/.config/kisui-terminal")
        );
        assert_eq!(
            config_dir(Some(Path::new("/x")), Some(home), false).unwrap(),
            Path::new("/x/kisui-terminal")
        );
        // 絶対パスでない XDG_CONFIG_HOME は使わない
        assert_eq!(
            config_dir(Some(Path::new("rel")), Some(home), false).unwrap(),
            Path::new("/home/u/.config/kisui-terminal")
        );
        assert!(config_dir(None, None, false).is_none());
    }

    #[test]
    fn nightly_dir_only_when_it_exists() {
        let tmp = std::env::temp_dir().join(format!("kisui-gui-cfg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("kisui-terminal")).unwrap();
        assert_eq!(
            config_dir(Some(&tmp), None, true).unwrap(),
            tmp.join("kisui-terminal")
        );
        fs::create_dir_all(tmp.join("kisui-terminal-nightly")).unwrap();
        assert_eq!(
            config_dir(Some(&tmp), None, true).unwrap(),
            tmp.join("kisui-terminal-nightly")
        );
        assert_eq!(
            config_dir(Some(&tmp), None, false).unwrap(),
            tmp.join("kisui-terminal")
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn missing_dir_is_empty() {
        assert_eq!(load_dir(Path::new("/nonexistent")).unwrap(), vec![]);
    }

    // 以前の版の `[gui] url_open` が残っていても、間違いにしない（値が何でも無視する）
    #[test]
    fn old_url_open_is_ignored() {
        for v in ["\"builtin\"", "\"external\"", "\"firefox\"", "1"] {
            let text = format!("[gui]\nurl_open = {v}\n[[gui.machines]]\nssh = \"a\"\n");
            let m = parse(&text).unwrap();
            assert_eq!(m.len(), 1, "{v}");
            assert_eq!(m[0].ssh, "a", "{v}");
        }
    }

    /// 空の一時フォルダを作る。
    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kisui-gui-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn machine(ssh: &str) -> ConfigMachine {
        ConfigMachine {
            ssh: ssh.into(),
            name: None,
            local: false,
        }
    }

    /// config.local.toml のマシン。
    fn local(ssh: &str, name: Option<&str>) -> ConfigMachine {
        ConfigMachine {
            ssh: ssh.into(),
            name: name.map(str::to_string),
            local: true,
        }
    }

    // 2 つのファイルの一覧は、ssh の行き先ごとに重ねる。同じ行き先は config.local.toml の項目が代わり、片方にしかない項目は残る
    #[test]
    fn local_merges_machines_by_ssh() {
        let d = temp_dir("local-merges");
        fs::write(
            d.join("config.toml"),
            "[[gui.machines]]\nssh = \"a\"\n[[gui.machines]]\nssh = \"b\"\nname = \"bee\"\n[[gui.machines]]\nssh = \"c\"\n",
        )
        .unwrap();
        let named = |ssh: &str, name: &str| ConfigMachine {
            name: Some(name.into()),
            ..machine(ssh)
        };
        let base = vec![machine("a"), named("b", "bee"), machine("c")];
        assert_eq!(load_dir(&d).unwrap(), base);
        // 一覧の無い config.local.toml は、config.toml の一覧を変えない
        fs::write(
            d.join("config.local.toml"),
            "[server]\nidle_stop_days = 1\n",
        )
        .unwrap();
        assert_eq!(load_dir(&d).unwrap(), base);
        // 空の一覧も、何も足さず、何も消さない
        fs::write(d.join("config.local.toml"), "[gui]\nmachines = []\n").unwrap();
        assert_eq!(load_dir(&d).unwrap(), base);
        // config.toml の順のまま、同じ行き先（b）はその場所で代わり、config.local.toml にだけある項目（d）は後ろに続く
        fs::write(
            d.join("config.local.toml"),
            "[[gui.machines]]\nssh = \"d\"\n[[gui.machines]]\nssh = \"b\"\nname = \"B\"\n",
        )
        .unwrap();
        assert_eq!(
            load_dir(&d).unwrap(),
            vec![
                machine("a"),
                local("b", Some("B")),
                machine("c"),
                local("d", None)
            ]
        );
        // 項目は丸ごと代わる。config.toml にだけ書いた名前は引き継がない
        fs::write(
            d.join("config.local.toml"),
            "[[gui.machines]]\nssh = \"b\"\n",
        )
        .unwrap();
        assert_eq!(
            load_dir(&d).unwrap(),
            vec![machine("a"), local("b", None), machine("c")]
        );
        // config.local.toml だけでもよい
        fs::remove_file(d.join("config.toml")).unwrap();
        assert_eq!(load_dir(&d).unwrap(), vec![local("b", None)]);
        let _ = fs::remove_dir_all(&d);
    }

    // 重ねたあとに名前が重なったら、config.local.toml の行を指して間違いにする。代わった項目の前の名前とは重ならない
    #[test]
    fn merged_machine_names_must_differ() {
        let d = temp_dir("local-names");
        fs::write(
            d.join("config.toml"),
            "[[gui.machines]]\nssh = \"a\"\nname = \"x\"\n[[gui.machines]]\nssh = \"b\"\n",
        )
        .unwrap();
        let local_path = d.join("config.local.toml");
        // 名前が config.toml のマシンの名前と同じ
        fs::write(&local_path, "[[gui.machines]]\nssh = \"c\"\nname = \"x\"\n").unwrap();
        let e = load_dir(&d).unwrap_err();
        assert!(
            e.starts_with(&format!("{}:3: gui.machines[0]: ", local_path.display())),
            "{e}"
        );
        // 名前を省いた項目の ssh の行き先が、config.toml のマシンの名前と同じ
        fs::write(
            &local_path,
            "[[gui.machines]]\nssh = \"z\"\n[[gui.machines]]\nssh = \"x\"\n",
        )
        .unwrap();
        let e = load_dir(&d).unwrap_err();
        assert!(
            e.starts_with(&format!("{}:4: gui.machines[1]: ", local_path.display())),
            "{e}"
        );
        // 名前が config.toml のマシンの ssh の行き先と同じ
        fs::write(&local_path, "[[gui.machines]]\nssh = \"c\"\nname = \"b\"\n").unwrap();
        assert!(load_dir(&d).is_err());
        // a を代えた項目は、a の前の名前（x）を使える。a が手放した名前は、ほかの項目が使える
        fs::write(&local_path, "[[gui.machines]]\nssh = \"a\"\nname = \"x\"\n").unwrap();
        assert_eq!(
            load_dir(&d).unwrap(),
            vec![local("a", Some("x")), machine("b")]
        );
        fs::write(
            &local_path,
            "[[gui.machines]]\nssh = \"a\"\nname = \"y\"\n[[gui.machines]]\nssh = \"c\"\nname = \"x\"\n",
        )
        .unwrap();
        assert_eq!(
            load_dir(&d).unwrap(),
            vec![local("a", Some("y")), machine("b"), local("c", Some("x"))]
        );
        // 書く前の確かめ（check_local）も同じ結果になる。ファイルは変えない
        assert!(check_local(&d, "[[gui.machines]]\nssh = \"c\"\nname = \"x\"\n").is_err());
        assert!(check_local(&d, "[[gui.machines]]\nssh = \"c\"\n").is_ok());
        assert!(check_local(&d, "[[gui.machines]]\nssh = \"-o\"\n").is_err());
        assert_eq!(load_dir(&d).unwrap().len(), 3);
        let _ = fs::remove_dir_all(&d);
    }

    // 間違いは、どちらのファイルのものも、ファイルの場所を付けて出す
    #[test]
    fn errors_of_both_files() {
        let d = temp_dir("errs");
        fs::write(d.join("config.toml"), "[[gui.machines]]\nssh = 1\n").unwrap();
        fs::write(d.join("config.local.toml"), "a = \n").unwrap();
        let e = load_dir(&d).unwrap_err();
        let lines: Vec<&str> = e.lines().collect();
        assert_eq!(lines.len(), 2, "{e}");
        assert!(
            lines[0].starts_with(&format!("{}:2: ", d.join("config.toml").display())),
            "{e}"
        );
        assert!(
            lines[1].starts_with(&format!("{}:1: ", d.join("config.local.toml").display())),
            "{e}"
        );
        let _ = fs::remove_dir_all(&d);
    }

    // [gui] mascot は config.local.toml が勝つ。空の文字列は出さない
    #[test]
    fn mascot_name_local_wins() {
        let d = temp_dir("mascot");
        assert_eq!(mascot_name(&d), None);
        fs::write(d.join("config.toml"), "[gui]\nmascot = \"neko\"\n").unwrap();
        assert_eq!(mascot_name(&d).as_deref(), Some("neko"));
        fs::write(
            d.join("config.local.toml"),
            "[server]\nidle_stop_days = 1\n",
        )
        .unwrap();
        assert_eq!(mascot_name(&d).as_deref(), Some("neko"));
        fs::write(d.join("config.local.toml"), "[gui]\nmascot = \"inu\"\n").unwrap();
        assert_eq!(mascot_name(&d).as_deref(), Some("inu"));
        // 文字列でない値は、書いていないのと同じ（config.toml の値を使う）
        fs::write(d.join("config.local.toml"), "[gui]\nmascot = 5\n").unwrap();
        assert_eq!(mascot_name(&d).as_deref(), Some("neko"));
        fs::write(d.join("config.local.toml"), "[gui]\nmascot = \"\"\n").unwrap();
        assert_eq!(mascot_name(&d), None);
        // マシンの一覧は mascot を読み飛ばす
        fs::write(
            d.join("config.toml"),
            "[gui]\nmascot = \"neko\"\n[[gui.machines]]\nssh = \"a\"\n",
        )
        .unwrap();
        fs::remove_file(d.join("config.local.toml")).unwrap();
        assert_eq!(load_dir(&d).unwrap(), vec![machine("a")]);
        let _ = fs::remove_dir_all(&d);
    }

    // `ui-language`（#174）。無い・分からない値は英語、config.local.toml が勝つ
    #[test]
    fn ui_language_local_wins() {
        let d = temp_dir("ui-language");
        assert_eq!(ui_language(&d), "en");
        fs::write(d.join("config.toml"), "ui-language = \"ja\"\n").unwrap();
        assert_eq!(ui_language(&d), "ja");
        fs::write(d.join("config.local.toml"), "ui-language = \"en\"\n").unwrap();
        assert_eq!(ui_language(&d), "en");
        // 分からない値・文字列でない値は、書いていないのと同じ（前のファイルの値を使う）
        fs::write(d.join("config.local.toml"), "ui-language = \"fr\"\n").unwrap();
        assert_eq!(ui_language(&d), "ja");
        fs::write(d.join("config.local.toml"), "ui-language = 5\n").unwrap();
        assert_eq!(ui_language(&d), "ja");
        // マシンの一覧は ui-language を読み飛ばす
        fs::write(
            d.join("config.toml"),
            "ui-language = \"ja\"\n[[gui.machines]]\nssh = \"a\"\n",
        )
        .unwrap();
        fs::remove_file(d.join("config.local.toml")).unwrap();
        assert_eq!(load_dir(&d).unwrap(), vec![machine("a")]);
        let _ = fs::remove_dir_all(&d);
    }

    // [gui.shortcuts]（#199）。キーごとに重ね、同じキーは config.local.toml が勝つ。間違った型は間違いにする
    #[test]
    fn shortcuts_merge_by_key() {
        let d = temp_dir("shortcuts");
        assert!(load_gui(&d).unwrap().shortcuts.is_empty());
        fs::write(
            d.join("config.toml"),
            "[gui.shortcuts]\n\"Ctrl+Shift+N\" = \"workspace.new\"\n\"Cmd+D\" = \"none\"\n",
        )
        .unwrap();
        fs::write(
            d.join("config.local.toml"),
            "[gui.shortcuts]\n\"Ctrl+Shift+N\" = \"pane.focus:left\"\n\"Alt+J\" = \"pane.focus:down\"\n",
        )
        .unwrap();
        let got: Vec<(String, String)> = load_gui(&d)
            .unwrap()
            .shortcuts
            .into_iter()
            .map(|s| (s.key, s.command))
            .collect();
        let pair = |k: &str, c: &str| (k.to_string(), c.to_string());
        assert_eq!(
            got,
            vec![
                pair("Alt+J", "pane.focus:down"),
                pair("Cmd+D", "none"),
                pair("Ctrl+Shift+N", "pane.focus:left"),
            ]
        );
        fs::write(d.join("config.local.toml"), "[gui.shortcuts]\nx = 1\n").unwrap();
        assert!(load_gui(&d).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    // config.nix は読まない
    #[test]
    fn config_nix_is_not_read() {
        let d = temp_dir("nix");
        fs::write(
            d.join("config.nix"),
            "{ gui.machines = [ { ssh = \"a\"; } ]; }\n",
        )
        .unwrap();
        assert_eq!(load_dir(&d).unwrap(), vec![]);
        let _ = fs::remove_dir_all(&d);
    }

    // 選んだキャラクターは config.local.toml に書く。config.toml は触らない（読み取り専用でもよい）。ほかの項目とコメントは残す
    #[test]
    fn write_mascot_name_keeps_the_rest() {
        use std::os::unix::fs::PermissionsExt;
        let d = temp_dir("write-mascot");
        // ファイルが無ければ作る。config.toml は作らない
        write_mascot_name(&d, "neko").unwrap();
        assert_eq!(
            fs::read_to_string(d.join("config.local.toml")).unwrap(),
            "[gui]\nmascot = \"neko\"\n"
        );
        assert!(!d.join("config.toml").exists());
        // 読み取り専用の config.toml があっても書ける。config.toml の名前より勝つ
        fs::write(d.join("config.toml"), "[gui]\nmascot = \"inu\"\n").unwrap();
        fs::set_permissions(d.join("config.toml"), fs::Permissions::from_mode(0o444)).unwrap();
        write_mascot_name(&d, "tori").unwrap();
        assert_eq!(mascot_name(&d).as_deref(), Some("tori"));
        assert_eq!(
            fs::read_to_string(d.join("config.toml")).unwrap(),
            "[gui]\nmascot = \"inu\"\n"
        );
        // 前の値だけを替える。行末のコメントも、ほかの項目と表も残す
        let src = "# 自分の設定\n[gui]\nmascot = \"inu\" # 前のキャラクター\n\n[gui.browser]\nenabled = true\n\n[[gui.machines]]\nssh = \"a\"\n";
        fs::write(d.join("config.local.toml"), src).unwrap();
        write_mascot_name(&d, "neko").unwrap();
        assert_eq!(
            fs::read_to_string(d.join("config.local.toml")).unwrap(),
            src.replace("\"inu\"", "\"neko\"")
        );
        // `[gui]` の見出しが無いファイル（`[gui.browser]` だけ）には、見出しごと足す
        let src = "# コメント\n[gui.browser]\nenabled = true\n";
        fs::write(d.join("config.local.toml"), src).unwrap();
        write_mascot_name(&d, "neko").unwrap();
        let out = fs::read_to_string(d.join("config.local.toml")).unwrap();
        assert!(out.contains("# コメント\n"), "{out}");
        assert!(out.contains("enabled = true"), "{out}");
        assert_eq!(mascot_name(&d).as_deref(), Some("neko"));
        assert!(load_gui(&d).unwrap().browser);
        // [gui] の無いファイル
        fs::write(d.join("config.local.toml"), "# だけ\n").unwrap();
        write_mascot_name(&d, "neko").unwrap();
        assert_eq!(mascot_name(&d).as_deref(), Some("neko"));
        // 壊れたファイルは上書きしない
        fs::write(d.join("config.local.toml"), "[gui\nmascot = ").unwrap();
        let e = write_mascot_name(&d, "neko").unwrap_err();
        assert!(e.contains("config.local.toml"), "{e}");
        assert_eq!(
            fs::read_to_string(d.join("config.local.toml")).unwrap(),
            "[gui\nmascot = "
        );
        // シンボリックリンクなら、リンクは外さず、先を置き換える。一時ファイルは残さない
        let real = d.join("real.toml");
        fs::write(&real, "# 実体\n").unwrap();
        fs::remove_file(d.join("config.local.toml")).unwrap();
        std::os::unix::fs::symlink(&real, d.join("config.local.toml")).unwrap();
        write_mascot_name(&d, "inu").unwrap();
        assert!(fs::symlink_metadata(d.join("config.local.toml"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(fs::read_to_string(&real).unwrap().contains("# 実体\n"));
        assert_eq!(mascot_name(&d).as_deref(), Some("inu"));
        let leftovers = fs::read_dir(&d)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".kisui-")
            })
            .count();
        assert_eq!(leftovers, 0);
        // 設定のフォルダが無ければ作る
        let sub = d.join("new").join("kisui-terminal");
        write_mascot_name(&sub, "neko").unwrap();
        assert_eq!(mascot_name(&sub).as_deref(), Some("neko"));
        let _ = fs::remove_dir_all(&d);
    }

    // [gui.sidebar] tabs-height（#284）。書いていなければ None、config.local.toml が勝つ。範囲外・整数でない値は間違い
    #[test]
    fn sidebar_tabs_height() {
        let d = temp_dir("sidebar");
        assert_eq!(load_gui(&d).unwrap().sidebar_tabs_height, None);
        fs::write(d.join("config.toml"), "[gui.sidebar]\ntabs-height = 30\n").unwrap();
        assert_eq!(load_gui(&d).unwrap().sidebar_tabs_height, Some(30));
        fs::write(
            d.join("config.local.toml"),
            "[[gui.machines]]\nssh = \"b\"\n",
        )
        .unwrap();
        assert_eq!(load_gui(&d).unwrap().sidebar_tabs_height, Some(30));
        fs::write(
            d.join("config.local.toml"),
            "[gui.sidebar]\ntabs-height = 55\n",
        )
        .unwrap();
        assert_eq!(load_gui(&d).unwrap().sidebar_tabs_height, Some(55));
        for bad in ["5", "91", "-1", "40.5", "\"40\""] {
            fs::write(
                d.join("config.local.toml"),
                format!("[gui.sidebar]\ntabs-height = {bad}\n"),
            )
            .unwrap();
            let e = load_gui(&d).unwrap_err();
            assert!(
                e.starts_with(&format!("{}:2: ", d.join("config.local.toml").display())),
                "{bad}: {e}"
            );
        }
        let _ = fs::remove_dir_all(&d);
    }

    // [gui.browser] enabled（#202）。書いていなければ使わない。config.local.toml が勝つ
    #[test]
    fn browser_is_off_unless_enabled() {
        let d = temp_dir("browser");
        assert!(!load_gui(&d).unwrap().browser);
        fs::write(
            d.join("config.toml"),
            "[gui.browser]\nenabled = true\n[[gui.machines]]\nssh = \"a\"\n",
        )
        .unwrap();
        let g = load_gui(&d).unwrap();
        assert!(g.browser);
        assert_eq!(g.machines, vec![machine("a")]);
        // 書いていない config.local.toml は変えない
        fs::write(
            d.join("config.local.toml"),
            "[[gui.machines]]\nssh = \"b\"\n",
        )
        .unwrap();
        assert!(load_gui(&d).unwrap().browser);
        fs::write(
            d.join("config.local.toml"),
            "[gui.browser]\nenabled = false\n",
        )
        .unwrap();
        let g = load_gui(&d).unwrap();
        assert!(!g.browser);
        assert_eq!(g.machines, vec![machine("a")]);
        // 型の違いは間違い
        fs::write(
            d.join("config.local.toml"),
            "[gui.browser]\nenabled = \"yes\"\n",
        )
        .unwrap();
        let e = load_gui(&d).unwrap_err();
        assert!(
            e.starts_with(&format!("{}:2: ", d.join("config.local.toml").display())),
            "{e}"
        );
        let _ = fs::remove_dir_all(&d);
    }

    // [gui.browser] passkey_sites（#206）。書いてあるファイルのものを使い、config.local.toml が勝つ。
    // 前の版の passkey_browser（#433 で外した）は、何を書いても読み飛ばす
    #[test]
    fn passkey_sites() {
        let d = temp_dir("passkey");
        let g = load_gui(&d).unwrap();
        assert!(g.passkey_sites.is_empty());
        fs::write(
            d.join("config.toml"),
            "[gui.browser]\nenabled = true\npasskey_sites = [\"github.com\", \"dash.cloudflare.com\", \"github.com\"]\npasskey_browser = \"firefox\"\n",
        )
        .unwrap();
        let g = load_gui(&d).unwrap();
        assert_eq!(g.passkey_sites, vec!["github.com", "dash.cloudflare.com"]);
        // 書いていない config.local.toml は変えない。書けば勝つ（空の一覧も）
        fs::write(
            d.join("config.local.toml"),
            "[gui.browser]\nenabled = true\n",
        )
        .unwrap();
        assert_eq!(load_gui(&d).unwrap().passkey_sites.len(), 2);
        fs::write(
            d.join("config.local.toml"),
            "[gui.browser]\npasskey_sites = []\npasskey_browser = \"safari\"\n",
        )
        .unwrap();
        let g = load_gui(&d).unwrap();
        assert!(g.passkey_sites.is_empty());
        // 使えない名前は間違い
        for bad in [
            "passkey_sites = [\"https://github.com\"]",
            "passkey_sites = [\"GitHub.com\"]",
            "passkey_sites = [\"*.github.com\"]",
            "passkey_sites = [\"github.com/login\"]",
            "passkey_sites = [\"..github.com\"]",
            "passkey_sites = [\".\"]",
            "passkey_sites = [\"github.com.\"]",
            "passkey_sites = [\"github.com:443\"]",
        ] {
            fs::write(
                d.join("config.local.toml"),
                format!("[gui.browser]\n{bad}\n"),
            )
            .unwrap();
            let e = load_gui(&d).unwrap_err();
            assert!(
                e.starts_with(&format!("{}:2: ", d.join("config.local.toml").display())),
                "{bad}: {e}"
            );
        }
        let _ = fs::remove_dir_all(&d);
    }

    // passkey_sites の .google.com の書き方（#279）。公開サフィックスの項目は間違いにせず、使わずに知らせる
    #[test]
    fn passkey_sites_with_subdomains() {
        let d = temp_dir("passkey-sub");
        fs::write(
            d.join("config.toml"),
            "[gui.browser]\nenabled = true\npasskey_sites = [\".google.com\", \".com\", \"github.com\", \".github.io\", \".co.jp\", \".alice.github.io\", \".com\", \".internal\"]\n",
        )
        .unwrap();
        let g = load_gui(&d).unwrap();
        assert_eq!(
            g.passkey_sites,
            vec![".google.com", "github.com", ".alice.github.io"]
        );
        assert_eq!(
            g.passkey_rejected,
            vec![".com", ".github.io", ".co.jp", ".internal"]
        );
        // 画面には passkeyRejected で渡す（使う項目は渡さない）
        let v = serde_json::to_value(&g).unwrap();
        assert_eq!(
            v["passkeyRejected"],
            serde_json::json!([".com", ".github.io", ".co.jp", ".internal"])
        );
        assert!(v.get("passkey_sites").is_none());
        // 一覧を書き直したファイルが勝つ（使わない項目も、勝ったファイルのものだけ）
        fs::write(
            d.join("config.local.toml"),
            "[gui.browser]\npasskey_sites = [\"github.com\"]\n",
        )
        .unwrap();
        let g = load_gui(&d).unwrap();
        assert_eq!(g.passkey_sites, vec!["github.com"]);
        assert!(g.passkey_rejected.is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn public_suffix_sites() {
        for s in [
            ".com",
            ".jp",
            ".co.jp",
            ".github.io",
            ".internal",
            ".kobe.jp",
            ".ck",
            ".co.uk",
            // ワイルドカード（*.kobe.jp）の下の名前
            ".x.kobe.jp",
            // 日本語の名前の規則（中国 = xn--fiqs8s）
            ".xn--fiqs8s",
        ] {
            assert!(public_suffix_site(s), "{s}");
        }
        // github.com の書き方は見ない。公開サフィックスの下の名前は使える
        for s in [
            "com",
            "github.io",
            ".google.com",
            ".example.com",
            ".example.co.jp",
            ".example.co.uk",
            ".alice.github.io",
            ".a.x.kobe.jp",
            // 例外（!city.kobe.jp・!www.ck）はワイルドカードから外れる
            ".city.kobe.jp",
            ".www.ck",
            ".example.xn--fiqs8s",
        ] {
            assert!(!public_suffix_site(s), "{s}");
        }
    }
}
