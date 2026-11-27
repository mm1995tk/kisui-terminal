//! 手元のマシンの、新しいターミナルが始まるフォルダとシェル（`[server] start_dir`・`[server] shell`。#485）を、
//! Window から `config.local.toml` に書く（Tauri のコマンド `config_local_terminal_edit`）。
//!
//! リモートのマシンの分は `[[gui.machines]]` の項目に書く（config_list.rs の [`crate::config_list::MachineEdit::Terminal`]）。
//! 手元のマシンは `[[gui.machines]]` に項目が無く、手元の `kisui serve` が同じファイルの `[server]` を読むので、そこに書く。
//!
//! 書く前に確かめる：`start_dir` は、有るフォルダ。`shell` は、実行できるファイル（どちらも絶対パスか `~` で始まるパス。`~` は `$HOME`）。
//! 通らなければ書かない。`start_dir` のフォルダが無いと、手元の `kisui serve` は起動しない（`config/config.go`）。
//! `shell` は kisui より厳しい（kisui は形だけを確かめ、実行できなければ `$SHELL` で始める）：Window で入れた値は、その場で理由を
//! 出せるので、使えない値を書かせない。空（None・空白だけ）の項目は、`config.local.toml` から消す（`config.toml` に書いてあれば、そちらに戻る）。
//! ほかの項目・コメント・並びは変えない。

use std::path::{Path, PathBuf};

use toml_edit::{Item, Table, Value};

use crate::config::{self, TermDefaults};
use crate::config_list::EditError;

/// `~`・`~/x` を `home` の下のパスにする（絶対パスはそのまま）。形は確かめてあること。
fn expand(v: &str, home: Option<&Path>) -> Option<PathBuf> {
    match v.strip_prefix('~') {
        Some(rest) => Some(home?.join(rest.trim_start_matches('/'))),
        None => Some(PathBuf::from(v)),
    }
}

/// 実行できるファイルか（リンクは先を見る）。
fn runnable(p: &Path) -> bool {
    let Ok(m) = std::fs::metadata(p) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        m.is_file() && m.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        m.is_file()
    }
}

/// 前後の空白を除く。空なら None（その項目を消す）。
fn clean(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// 設定のフォルダ `dir` の `config.local.toml` の `[server]` に、`start_dir` と `shell` を書き（None は消す）、
/// 書いたあとの（2 つのファイルを重ねた）手元のマシンの分を返す。`home` は `~` を開くための `$HOME`。
pub fn edit_local(
    dir: &Path,
    home: Option<&Path>,
    start_dir: Option<String>,
    shell: Option<String>,
) -> Result<TermDefaults, EditError> {
    let (start_dir, shell) = (clean(start_dir), clean(shell));
    if let Some(v) = &start_dir {
        if !config::valid_start_dir(v) {
            return Err(EditError::Entry(format!(
                "server.start_dir: 絶対パスか、~ で始まるパスを書きます（{v}）"
            )));
        }
        if !expand(v, home).is_some_and(|p| p.is_dir()) {
            return Err(EditError::NotDir(v.clone()));
        }
    }
    if let Some(v) = &shell {
        if !config::valid_shell(v) {
            return Err(EditError::Entry(format!(
                "server.shell: シェルのファイルの絶対パスか、~/ で始まるパスを書きます（引数は書けません。{v}）"
            )));
        }
        if !expand(v, home).is_some_and(|p| runnable(&p)) {
            return Err(EditError::NotExec(v.clone()));
        }
    }
    let mut after = TermDefaults::default();
    config::edit_local(dir, |doc, path| {
        let shape = || EditError::File(format!("{}: [server] が表ではありません", path.display()));
        let values = [("start_dir", &start_dir), ("shell", &shell)];
        if values.iter().any(|(_, v)| v.is_some()) || doc.contains_key("server") {
            let server = doc
                .entry("server")
                .or_insert_with(|| Item::Table(Table::new()));
            let table = server.as_table_like_mut().ok_or_else(shape)?;
            for (key, value) in values {
                match (value, table.get_mut(key).and_then(|i| i.as_value_mut())) {
                    // 前の値の前後の空白と、行末のコメントを残す
                    (Some(v), Some(old)) => {
                        let decor = old.decor().clone();
                        let mut nv = Value::from(v.as_str());
                        *nv.decor_mut() = decor;
                        *old = nv;
                    }
                    (Some(v), None) => {
                        table.insert(key, Item::Value(Value::from(v.as_str())));
                    }
                    (None, _) => {
                        table.remove(key);
                    }
                }
            }
        }
        // 書く中身を、Window の読み込みと同じに確かめ、重ねたあとの値を取る（書き込みと同じ排他の中なので、次の書き込みと入れ違わない）
        after = config::load_with_local(dir, &doc.to_string())
            .map_err(EditError::Rejected)?
            .local_terminal;
        Ok::<(), EditError>(())
    })?;
    Ok(after)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "kisui-config-terminal-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 設定のフォルダ・ホーム・ホームの下のシェル（実行できるファイル）。
    fn setup(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = temp_dir(name);
        let (dir, home) = (root.join("config"), root.join("home"));
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(home.join("work")).unwrap();
        fs::create_dir_all(home.join("bin")).unwrap();
        let sh = home.join("bin/mysh");
        fs::write(&sh, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&sh, fs::Permissions::from_mode(0o755)).unwrap();
        }
        (dir, home, sh)
    }

    fn some(s: &str) -> Option<String> {
        Some(s.to_string())
    }

    #[test]
    fn writes_server_keys_and_keeps_the_rest() {
        let (dir, home, sh) = setup("write");
        let local = dir.join("config.local.toml");
        fs::write(
            &local,
            "# mine\n[server]\nidle_stop_days = 3 # days\nstart_dir = \"/\" # root\n\n[[gui.machines]]\nssh = \"a\"\n",
        )
        .unwrap();
        let got = edit_local(&dir, Some(&home), some(" ~/work "), some("~/bin/mysh")).unwrap();
        assert_eq!(
            got,
            TermDefaults {
                start_dir: some("~/work"),
                shell: some("~/bin/mysh"),
            }
        );
        assert_eq!(
            fs::read_to_string(&local).unwrap(),
            "# mine\n[server]\nidle_stop_days = 3 # days\nstart_dir = \"~/work\" # root\nshell = \"~/bin/mysh\"\n\n[[gui.machines]]\nssh = \"a\"\n"
        );
        // 絶対パスでも書ける。空にした項目は消す
        let got = edit_local(&dir, Some(&home), None, some(sh.to_str().unwrap())).unwrap();
        assert_eq!(got.start_dir, None);
        assert_eq!(got.shell.as_deref(), sh.to_str());
        assert!(!fs::read_to_string(&local).unwrap().contains("start_dir"));
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn makes_the_file_and_falls_back_to_config_toml() {
        let (dir, home, _) = setup("fallback");
        fs::write(dir.join("config.toml"), "[server]\nstart_dir = \"~\"\n").unwrap();
        let local = dir.join("config.local.toml");
        // 何も書かないなら、[server] を作らない
        let got = edit_local(&dir, Some(&home), None, None).unwrap();
        assert_eq!(got.start_dir.as_deref(), Some("~"));
        assert_eq!(fs::read_to_string(&local).unwrap(), "");
        let got = edit_local(&dir, Some(&home), some("~/work"), None).unwrap();
        assert_eq!(got.start_dir.as_deref(), Some("~/work"));
        assert_eq!(
            fs::read_to_string(&local).unwrap(),
            "[server]\nstart_dir = \"~/work\"\n"
        );
        // config.local.toml から消すと、config.toml のものに戻る
        let got = edit_local(&dir, Some(&home), Some("  ".into()), None).unwrap();
        assert_eq!(got.start_dir.as_deref(), Some("~"));
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    // kisui serve が起動しなくなる値は、書かない
    #[test]
    fn refuses_what_kisui_would_refuse() {
        let (dir, home, _) = setup("refuse");
        let local = dir.join("config.local.toml");
        fs::write(home.join("bin/plain"), "x").unwrap();
        let edit = |d: Option<&str>, s: Option<&str>| {
            edit_local(&dir, Some(&home), d.map(Into::into), s.map(Into::into))
        };
        assert_eq!(
            edit(Some("~/none"), None),
            Err(EditError::NotDir("~/none".into()))
        );
        assert_eq!(
            edit(Some("~/bin/mysh"), None),
            Err(EditError::NotDir("~/bin/mysh".into()))
        );
        assert!(matches!(edit(Some("work"), None), Err(EditError::Entry(_))));
        assert_eq!(
            edit(None, Some("~/bin/none")),
            Err(EditError::NotExec("~/bin/none".into()))
        );
        assert_eq!(
            edit(None, Some("~/work")),
            Err(EditError::NotExec("~/work".into()))
        );
        #[cfg(unix)]
        assert_eq!(
            edit(None, Some("~/bin/plain")),
            Err(EditError::NotExec("~/bin/plain".into()))
        );
        assert!(matches!(edit(None, Some("mysh")), Err(EditError::Entry(_))));
        assert_eq!(
            edit(None, Some("~/bin/mysh -l")),
            Err(EditError::NotExec("~/bin/mysh -l".into()))
        );
        assert!(!local.exists());
        // [server] が表でないファイルには書かない
        fs::write(&local, "server = 1\n").unwrap();
        assert!(matches!(
            edit(Some("~/work"), None),
            Err(EditError::File(_))
        ));
        assert_eq!(fs::read_to_string(&local).unwrap(), "server = 1\n");
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }
}
