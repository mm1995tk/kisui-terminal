//! 手元の設定ファイルの `[[gui.machines]]`。
//!
//! 読むのは設定のフォルダの `config.toml` と `config.local.toml` の 2 つ。`config.toml` が土台で、
//! `config.local.toml` を上に重ねる（kisui の `config/config.go` と同じファイルを同じ順で読む）。
//! `config.local.toml` に `[[gui.machines]]`（`[gui] machines = []` も）があれば、`config.toml` の一覧を丸ごと置き換える。
//! 無ければ `config.toml` の一覧を使う。どちらのファイルも無くてよい。
//! 窓が設定を書くときは `config.local.toml` に書く（`config.toml` は home-manager が読み取り専用で置くことがある）。
//! GUI が読むのはこの節だけ。ほかの節（`kisui serve` の `[server]` など）は kisui が読む。
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
pub(crate) fn base_dir(config_home: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    Some(match config_home {
        Some(d) if d.is_absolute() => d.to_path_buf(),
        _ => home?.join(".config"),
    })
}

/// `name` の設定フォルダ。nightly は `<name>-nightly`、無ければ `name`。
pub(crate) fn dir_of(base: &Path, name: &str, nightly: bool) -> PathBuf {
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
pub fn load_default() -> Result<Vec<ConfigMachine>, String> {
    let (xdg, home, nightly) = env();
    match config_dir(xdg.as_deref(), home.as_deref(), nightly) {
        Some(d) => load_dir(&d),
        None => Ok(Vec::new()),
    }
}

/// 設定のフォルダの 2 つのファイルを読んで重ねる。どちらかに間違いがあれば、全部の間違いを改行でつないで返す。
pub fn load_dir(dir: &Path) -> Result<Vec<ConfigMachine>, String> {
    let mut machines = Vec::new();
    let mut errs = Vec::new();
    for name in FILES {
        match load(&dir.join(name)) {
            // 一覧があるファイルが、前のファイルの一覧を丸ごと置き換える
            Ok(Some(m)) => machines = m,
            Ok(None) => {}
            Err(e) => errs.push(e),
        }
    }
    if errs.is_empty() {
        Ok(machines)
    } else {
        Err(errs.join("\n"))
    }
}

/// 設定ファイルを 1 つ読む。無いか `[[gui.machines]]` が書いていなければ None。
fn load(path: &Path) -> Result<Option<Vec<ConfigMachine>>, String> {
    let text = match fs::read(path) {
        Ok(b) => {
            String::from_utf8(b).map_err(|_| format!("{}: UTF-8 で読めません", path.display()))?
        }
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: 読めません（{e}）", path.display())),
    };
    parse_file(&text).map_err(|(line, why)| match line {
        Some(l) => format!("{}:{l}: {why}", path.display()),
        None => format!("{}: {why}", path.display()),
    })
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
fn parse_file(text: &str) -> Result<Option<Vec<ConfigMachine>>, (Option<usize>, String)> {
    let file: File = toml::from_str(text).map_err(|e| {
        (
            e.span().map(|s| line_of(text, s.start)),
            e.message().to_string(),
        )
    })?;
    let Some(entries) = file.gui.and_then(|g| g.machines) else {
        return Ok(None);
    };
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
    Ok(Some(out))
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
}
