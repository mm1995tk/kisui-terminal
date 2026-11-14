//! 手元の設定ファイルの `[[gui.machines]]` と `[gui.browser]`。
//!
//! 読むのは設定のフォルダの `config.toml` と `config.local.toml` の 2 つ。`config.toml` が土台で、
//! `config.local.toml` を上に重ねる（kisui の `config/config.go` と同じファイルを同じ順で読む）。
//! `config.local.toml` に `[[gui.machines]]`（`[gui] machines = []` も）があれば、`config.toml` の一覧を丸ごと置き換える。
//! 無ければ `config.toml` の一覧を使う。どちらのファイルも無くてよい。
//! `[gui.browser] enabled`（内蔵ブラウザのタブを使うか。#202）は、書いてあるファイルのものを使い、両方にあれば `config.local.toml` が勝つ。
//! どちらにも無ければ使わない。
//! 窓が設定を書くときは `config.local.toml` に書く（`config.toml` は home-manager が読み取り専用で置くことがある）。
//! GUI が読むのはこの節と `[gui] mascot`（リーダーの案内を運ぶキャラクターの名前。mascot.rs）だけ。ほかの節（`kisui serve` の `[server]` など）は kisui が読む。
//! 知らない項目は間違いにしない（新しい版用に書いた項目があっても起動する）。読み飛ばす。
//! 間違い（TOML の書き方・型の違い・使えない ssh の行き先・重なり）は、
//! 「ファイル:行: 理由」の 1 行の文字列にして返す（2 つのファイルにあれば改行でつなぐ）。画面側はそれを出して、ほかは何もしない（起動しない）。
//! 置き場は `$XDG_CONFIG_HOME` が絶対パスならそれ、なければ `~/.config` の下の `kisui-terminal/`
//! （nightly の GUI は `kisui-terminal-nightly/`、そのフォルダが無ければ `kisui-terminal/`）。
//! shijimi-editor の設定のフォルダ（`shijimi-editor/`）は読まない。

use std::collections::HashSet;
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
}

#[derive(Deserialize)]
struct File {
    // ほかの節は kisui（`[server]`）などが読む
    gui: Option<Gui>,
}

#[derive(Deserialize)]
struct Gui {
    // 書いていない（None）と書いて空（Some(空)）を分ける。config.local.toml の空の一覧は、config.toml の一覧を消す
    machines: Option<Vec<Entry>>,
    /// 内蔵ブラウザ（#202）
    browser: Option<Browser>,
}

/// `[gui.browser]`。
#[derive(Deserialize)]
struct Browser {
    /// 内蔵ブラウザのタブを使うか。書いていなければ使わない。config.local.toml に書けば、config.toml のものより勝つ
    enabled: Option<bool>,
}

/// 設定ファイルの GUI の節（`[gui]`）のうち、画面が使うもの。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct GuiConfig {
    pub machines: Vec<ConfigMachine>,
    /// 内蔵ブラウザのタブを使うか（`[gui.browser] enabled`。初めは使わない）
    pub browser: bool,
}

/// 1 つのファイルから読んだもの（書いていない項目は None）。
#[derive(Default)]
struct Parsed {
    machines: Option<Vec<ConfigMachine>>,
    browser: Option<bool>,
}

#[derive(Deserialize)]
struct Entry {
    ssh: Spanned<String>,
    name: Option<Spanned<String>>,
}

/// 「ローカル」の名前（GUI の LOCAL_LABEL と同じ。この名前のマシンは出せない）。
const LOCAL_LABEL: &str = "ローカル";

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
    let mut out = GuiConfig::default();
    let mut errs = Vec::new();
    for name in FILES {
        match load(&dir.join(name)) {
            Ok(p) => {
                // 一覧があるファイルが、前のファイルの一覧を丸ごと置き換える
                if let Some(m) = p.machines {
                    out.machines = m;
                }
                // 書いてあるファイルが、前のファイルのものに勝つ
                if let Some(b) = p.browser {
                    out.browser = b;
                }
            }
            Err(e) => errs.push(e),
        }
    }
    if errs.is_empty() {
        Ok(out)
    } else {
        Err(errs.join("\n"))
    }
}

/// `load_gui` のマシンの一覧だけ。
#[cfg(test)]
fn load_dir(dir: &Path) -> Result<Vec<ConfigMachine>, String> {
    load_gui(dir).map(|g| g.machines)
}

/// 設定ファイルを 1 つ読む。無ければ何も書いていないものとする。
fn load(path: &Path) -> Result<Parsed, String> {
    let text = match fs::read(path) {
        Ok(b) => {
            String::from_utf8(b).map_err(|_| format!("{}: UTF-8 で読めません", path.display()))?
        }
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Parsed::default()),
        Err(e) => return Err(format!("{}: 読めません（{e}）", path.display())),
    };
    parse_all(&text).map_err(|(line, why)| match line {
        Some(l) => format!("{}:{l}: {why}", path.display()),
        None => format!("{}: {why}", path.display()),
    })
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
    use toml_edit::{DocumentMut, Item, Table, Value};
    let path = dir.join("config.local.toml");
    let text = match fs::read(&path) {
        Ok(b) => {
            String::from_utf8(b).map_err(|_| format!("{}: UTF-8 で読めません", path.display()))?
        }
        Err(e) if e.kind() == ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("{}: 読めません（{e}）", path.display())),
    };
    let mut doc: DocumentMut = text
        .parse()
        .map_err(|e| format!("{}: TOML として読めません（{e}）", path.display()))?;
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
    fs::create_dir_all(dir).map_err(|e| format!("{}: 作れません（{e}）", dir.display()))?;
    replace_file(&path, doc.to_string().as_bytes())
        .map_err(|e| format!("{}: 書けません（{e}）", path.display()))
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
    let written = fs::File::create(&tmp).and_then(|mut f| {
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
    parse_all(text).map(|p| p.machines)
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
    let browser = gui.browser.and_then(|b| b.enabled);
    let machines = match gui.machines {
        Some(entries) => Some(check_machines(text, entries)?),
        None => None,
    };
    Ok(Parsed { machines, browser })
}

/// `[[gui.machines]]` を確かめる。
fn check_machines(
    text: &str,
    entries: Vec<Entry>,
) -> Result<Vec<ConfigMachine>, (Option<usize>, String)> {
    let mut out: Vec<ConfigMachine> = Vec::new();
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
        if label == LOCAL_LABEL || !labels.insert(label.clone()) {
            let n = e.name.as_ref().unwrap_or(&e.ssh);
            return Err((
                at(n),
                format!("gui.machines[{i}]: 名前 {label} はほかのマシンで使っています"),
            ));
        }
        out.push(ConfigMachine { ssh, name });
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
                    name: Some("dev".into())
                },
                ConfigMachine {
                    ssh: "build".into(),
                    name: None
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
        }
    }

    // config.local.toml の一覧は、config.toml の一覧を丸ごと置き換える
    #[test]
    fn local_replaces_machines() {
        let d = temp_dir("local-wins");
        fs::write(
            d.join("config.toml"),
            "[[gui.machines]]\nssh = \"a\"\n[[gui.machines]]\nssh = \"b\"\n",
        )
        .unwrap();
        assert_eq!(load_dir(&d).unwrap(), vec![machine("a"), machine("b")]);
        // 一覧の無い config.local.toml は、config.toml の一覧を変えない
        fs::write(
            d.join("config.local.toml"),
            "[server]\nidle_stop_days = 1\n",
        )
        .unwrap();
        assert_eq!(load_dir(&d).unwrap(), vec![machine("a"), machine("b")]);
        fs::write(
            d.join("config.local.toml"),
            "[[gui.machines]]\nssh = \"c\"\n",
        )
        .unwrap();
        assert_eq!(load_dir(&d).unwrap(), vec![machine("c")]);
        // 空の一覧も置き換える
        fs::write(d.join("config.local.toml"), "[gui]\nmachines = []\n").unwrap();
        assert_eq!(load_dir(&d).unwrap(), vec![]);
        // config.local.toml だけでもよい
        fs::remove_file(d.join("config.toml")).unwrap();
        fs::write(
            d.join("config.local.toml"),
            "[[gui.machines]]\nssh = \"c\"\n",
        )
        .unwrap();
        assert_eq!(load_dir(&d).unwrap(), vec![machine("c")]);
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
}
