//! `~/.ssh/config` のホスト一覧。
//!
//! 取るのは `Host` 行の名前のうち、そのまま `ssh <名前>` で使えるもの。
//! - `*` `?` `!` を含むパターンは捨てる（名前ではない）。
//! - `Include` は読む（`~` と相対パス、ファイル名の部分の `*` `?`）。相対パスは `~/.ssh` からの相対（ssh と同じ）。
//! - `Match` ブロックの中かどうかは見ない（`Host` 行だけを拾う）。
//! - 読めないファイルは黙って飛ばす。深さは 8 まで（循環の止め）。

use std::fs;
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 8;

/// ホーム直下の `~/.ssh/config` からホスト名を集める。
pub fn list_hosts(home: &Path) -> Vec<String> {
    let ssh_dir = home.join(".ssh");
    let mut out = Vec::new();
    collect(&ssh_dir.join("config"), home, &ssh_dir, 0, &mut out);
    out
}

fn collect(path: &Path, home: &Path, ssh_dir: &Path, depth: usize, out: &mut Vec<String>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(text) = fs::read(path) else { return };
    let text = String::from_utf8_lossy(&text);
    for raw in text.lines() {
        let Some((key, rest)) = split_directive(raw) else {
            continue;
        };
        if key.eq_ignore_ascii_case("host") {
            for name in split_args(rest) {
                if is_plain_host(&name) && !out.contains(&name) {
                    out.push(name);
                }
            }
        } else if key.eq_ignore_ascii_case("include") {
            for pat in split_args(rest) {
                for file in expand_include(&pat, home, ssh_dir) {
                    collect(&file, home, ssh_dir, depth + 1, out);
                }
            }
        }
    }
}

/// `Key value` と `Key=value` の両方を割る。空行とコメントは None。
fn split_directive(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let key = &line[..end];
    let rest = line[end..].trim_start_matches(|c: char| c.is_whitespace() || c == '=');
    Some((key, rest))
}

/// 空白で割る。`"..."` で囲んだ中の空白は割らない。`#` から後ろは捨てる。
fn split_args(s: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    let mut has = false;
    for c in s.chars() {
        match c {
            '"' => {
                in_quote = !in_quote;
                has = true;
            }
            '#' if !in_quote => break,
            c if c.is_whitespace() && !in_quote => {
                if has {
                    args.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        args.push(cur);
    }
    args
}

fn is_plain_host(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && !name.contains(['*', '?', '!', ',', '%'])
        && !name.chars().any(char::is_whitespace)
}

fn expand_include(pat: &str, home: &Path, ssh_dir: &Path) -> Vec<PathBuf> {
    let path = if let Some(rest) = pat.strip_prefix("~/") {
        home.join(rest)
    } else if Path::new(pat).is_absolute() {
        PathBuf::from(pat)
    } else {
        ssh_dir.join(pat)
    };
    let (Some(dir), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else {
        return Vec::new();
    };
    if !name.contains(['*', '?']) {
        return vec![path];
    }
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = rd
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| glob_match(name.as_bytes(), n.as_bytes()))
        })
        .map(|e| e.path())
        .collect();
    files.sort(); // ssh も辞書順で読む
    files
}

/// `*`（0 文字以上）と `?`（1 文字）だけのワイルドカード。
fn glob_match(pat: &[u8], s: &[u8]) -> bool {
    match pat.split_first() {
        None => s.is_empty(),
        Some((b'*', rest)) => (0..=s.len()).any(|i| glob_match(rest, &s[i..])),
        Some((b'?', rest)) => !s.is_empty() && glob_match(rest, &s[1..]),
        Some((c, rest)) => s.first() == Some(c) && glob_match(rest, &s[1..]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("shj-sshcfg-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join(".ssh/conf.d")).unwrap();
        d
    }

    #[test]
    fn hosts_skip_patterns_and_dedupe() {
        let home = tmp("a");
        fs::write(
            home.join(".ssh/config"),
            "# comment\nHost web db  # trailing\n  HostName x\nHost *\nHost !bad ok?\nHost=eq\nHost \"quoted\" web\nHost -oProxyCommand=x\n",
        )
        .unwrap();
        assert_eq!(list_hosts(&home), ["web", "db", "eq", "quoted"]);
    }

    #[test]
    fn include_relative_tilde_glob_and_cycle() {
        let home = tmp("b");
        fs::write(
            home.join(".ssh/config"),
            "Include conf.d/*.conf\nInclude ~/.ssh/extra\nHost top\nInclude config\n",
        )
        .unwrap();
        fs::write(home.join(".ssh/conf.d/b.conf"), "Host b\n").unwrap();
        fs::write(home.join(".ssh/conf.d/a.conf"), "Host a\n").unwrap();
        fs::write(home.join(".ssh/conf.d/skip.txt"), "Host skip\n").unwrap();
        fs::write(home.join(".ssh/extra"), "Host extra\n").unwrap();
        assert_eq!(list_hosts(&home), ["a", "b", "extra", "top"]);
    }

    #[test]
    fn missing_config_is_empty() {
        let home = tmp("c");
        assert!(list_hosts(&home).is_empty());
    }
}
