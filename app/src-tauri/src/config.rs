//! 手元の設定ファイル（`~/.config/kisui-terminal/config.toml`）の `[[gui.machines]]`。
//!
//! GUI が読むのはこの節だけ。ほかの節（`kisui serve` の `[server]` など）は kisui が読む。
//! 間違い（TOML の書き方・型の違い・使えない ssh の行き先・重なり）は、
//! 知らない項目は間違いにしない（新しい版用に書いた項目があっても起動する）。読み飛ばす。
//! 「ファイル:行: 理由」の 1 行の文字列にして返す。画面側はそれを出して、ほかは何もしない（起動しない）。
//! 置き場は `$XDG_CONFIG_HOME` が絶対パスならそれ、なければ `~/.config` の下の `kisui-terminal/`
//! （nightly の GUI は `kisui-terminal-nightly/`、そのフォルダが無ければ `kisui-terminal/`）。
//! shijimi-editor の設定ファイル（`shijimi-editor/config.toml`）の `[[gui.machines]]` と `[server]` は読まない。
//! 以前の版はそこに書いたので、書いてあれば `moved_from_shj_default` が知らせる（画面がお知らせを出す）。

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
    #[serde(default)]
    machines: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    ssh: Spanned<String>,
    name: Option<Spanned<String>>,
}

/// 「ローカル」の名前（GUI の LOCAL_LABEL と同じ。この名前のマシンは出せない）。
const LOCAL_LABEL: &str = "ローカル";

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

/// 設定ファイルの置き場所（kisui-terminal 自身のもの）。`config_home` は `$XDG_CONFIG_HOME`（絶対パスのときだけ使う）、`home` は `$HOME`。
pub fn config_path(
    config_home: Option<&Path>,
    home: Option<&Path>,
    nightly: bool,
) -> Option<PathBuf> {
    let base = base_dir(config_home, home)?;
    Some(dir_of(&base, "kisui-terminal", nightly).join("config.toml"))
}

/// 以前の版が使っていた shijimi-editor の設定ファイルの置き場所。今は読まない。
fn shj_config_path(
    config_home: Option<&Path>,
    home: Option<&Path>,
    nightly: bool,
) -> Option<PathBuf> {
    let base = base_dir(config_home, home)?;
    Some(dir_of(&base, "shijimi-editor", nightly).join("config.toml"))
}

/// 環境（`$XDG_CONFIG_HOME`・`$HOME`・nightly か）。
fn env() -> (Option<PathBuf>, Option<PathBuf>, bool) {
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let nightly = matches!(
        crate::locate::split_version(crate::version::get()),
        Some((_, Some(_)))
    );
    (xdg, home, nightly)
}

/// 環境から設定ファイルの場所を決めて読む。
pub fn load_default() -> Result<Vec<ConfigMachine>, String> {
    let (xdg, home, nightly) = env();
    match config_path(xdg.as_deref(), home.as_deref(), nightly) {
        Some(p) => load(&p),
        None => Ok(Vec::new()),
    }
}

/// shijimi-editor の設定ファイルに、kisui-terminal の設定（`[[gui.machines]]` か `[server]`）が
/// 残っているか。読めない・書き方が違うファイルは「残っていない」とする（shj が知らせる）。
pub fn moved_from_shj_default() -> bool {
    let (xdg, home, nightly) = env();
    shj_config_path(xdg.as_deref(), home.as_deref(), nightly)
        .and_then(|p| fs::read_to_string(p).ok())
        .is_some_and(|t| has_moved_keys(&t))
}

fn has_moved_keys(text: &str) -> bool {
    let Ok(t) = text.parse::<toml::Table>() else {
        return false;
    };
    t.contains_key("server")
        || t.get("gui")
            .and_then(|g| g.as_table())
            .is_some_and(|g| g.contains_key("machines"))
}

/// 設定ファイルを読む。無ければ空。
pub fn load(path: &Path) -> Result<Vec<ConfigMachine>, String> {
    let text = match fs::read(path) {
        Ok(b) => {
            String::from_utf8(b).map_err(|_| format!("{}: UTF-8 で読めません", path.display()))?
        }
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{}: 読めません（{e}）", path.display())),
    };
    parse(&text).map_err(|(line, why)| match line {
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

fn parse(text: &str) -> Result<Vec<ConfigMachine>, (Option<usize>, String)> {
    let file: File = toml::from_str(text).map_err(|e| {
        (
            e.span().map(|s| line_of(text, s.start)),
            e.message().to_string(),
        )
    })?;
    let entries = file.gui.map(|g| g.machines).unwrap_or_default();
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
            config_path(None, Some(home), false).unwrap(),
            Path::new("/home/u/.config/kisui-terminal/config.toml")
        );
        assert_eq!(
            config_path(Some(Path::new("/x")), Some(home), false).unwrap(),
            Path::new("/x/kisui-terminal/config.toml")
        );
        // 絶対パスでない XDG_CONFIG_HOME は使わない
        assert_eq!(
            config_path(Some(Path::new("rel")), Some(home), false).unwrap(),
            Path::new("/home/u/.config/kisui-terminal/config.toml")
        );
        assert!(config_path(None, None, false).is_none());
    }

    #[test]
    fn nightly_dir_only_when_it_exists() {
        let tmp = std::env::temp_dir().join(format!("kisui-gui-cfg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("kisui-terminal")).unwrap();
        assert_eq!(
            config_path(Some(&tmp), None, true).unwrap(),
            tmp.join("kisui-terminal/config.toml")
        );
        fs::create_dir_all(tmp.join("kisui-terminal-nightly")).unwrap();
        assert_eq!(
            config_path(Some(&tmp), None, true).unwrap(),
            tmp.join("kisui-terminal-nightly/config.toml")
        );
        assert_eq!(
            config_path(Some(&tmp), None, false).unwrap(),
            tmp.join("kisui-terminal/config.toml")
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn missing_file_is_empty() {
        assert_eq!(load(Path::new("/nonexistent/config.toml")).unwrap(), vec![]);
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

    #[test]
    fn old_location_keys_are_found() {
        assert!(has_moved_keys("[[gui.machines]]\nssh = \"a\"\n"));
        assert!(has_moved_keys("[server]\nidle_stop_days = 1\n"));
        assert!(has_moved_keys("theme = \"x\"\n[gui]\nmachines = []\n"));
        // shj 自身の項目だけなら、残っていない
        assert!(!has_moved_keys(
            "theme = \"x\"\nui-language = \"ja\"\n[gui]\ncolor = 1\n"
        ));
        assert!(!has_moved_keys(""));
        // 読めないファイルは、知らせない（shj が知らせる）
        assert!(!has_moved_keys("a = \n[server]\n"));
    }

    #[test]
    fn shj_path_is_the_old_place() {
        let home = Path::new("/home/u");
        assert_eq!(
            shj_config_path(None, Some(home), false).unwrap(),
            Path::new("/home/u/.config/shijimi-editor/config.toml")
        );
    }
}
