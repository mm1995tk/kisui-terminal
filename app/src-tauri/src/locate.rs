//! shj の探し方。
//!
//! - **このマシン**：Finder や Dock から起動した macOS のアプリは、ログインシェルの PATH を引き継がない
//!   （`/usr/bin:/bin:/usr/sbin:/sbin` だけ）。そこで、ログインシェルに PATH を聞き（時間切れ付き）、
//!   GUI の PATH とよく使う場所（[`COMMON_DIRS`]）を足した PATH で shj を探す。`shj attach` が起動する
//!   `shj serve` の中のターミナルも同じ PATH を引き継ぐよう、子プロセスの PATH もこれにする。
//! - **ssh 先**：ssh が動かすコマンドのシェル（非対話・非ログイン）の PATH には、Nix のプロファイルなどが
//!   入っていないことがある。GUI の版のキャッシュが無ければ、PATH とよく使う場所の shj のうち、
//!   **GUI と同じ版のもの**だけを使う（[`remote_attach_script`]）。版が違うものしか無ければ、今までどおり
//!   入れるかを聞く（C6。入れる先はキャッシュだけで、PATH の shj には触らない）。

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, OnceLock};
use std::time::Duration;

/// PATH に無くても見に行く場所。`$HOME` と `$USER` はそれぞれの場所で置き換える。
/// Nix（home-manager・nix-darwin・NixOS・単独の nix profile）、Homebrew、`go install`、`~/.local/bin`。
pub const COMMON_DIRS: &[&str] = &[
    "$HOME/.nix-profile/bin",
    "/etc/profiles/per-user/$USER/bin",
    "/run/current-system/sw/bin",
    "/nix/var/nix/profiles/default/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "$HOME/.local/bin",
    "$HOME/go/bin",
];

/// ログインシェルの答えを待つ上限。プロファイルが重い・止まるときは諦めて、よく使う場所だけで探す。
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(5);
const PATH_MARKER: &str = "@@shj-path@@";

/// ログインシェルの PATH（取れなければ None）。初めの 1 回だけ聞いて覚える。
/// 答えを待つ間は止まるので、メインスレッドからは呼ばない（`connect` は async のコマンド）。
fn login_shell_path() -> Option<&'static OsString> {
    static CACHE: OnceLock<Option<OsString>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let shell = std::env::var_os("SHELL")?;
            ask_login_shell_path(Path::new(&shell), LOGIN_SHELL_TIMEOUT)
        })
        .as_ref()
}

/// 起動のときに、別スレッドでログインシェルに PATH を聞き始めておく（「このマシン」につなぐときの待ちを短くする）。
pub fn warm_up() {
    std::thread::spawn(|| {
        let _ = login_shell_path();
    });
}

/// shell にログインシェルとして PATH を聞く。timeout までに閉じる側の印が来なければ None。
fn ask_login_shell_path(shell: &Path, timeout: Duration) -> Option<OsString> {
    if !shell.is_absolute() {
        return None;
    }
    // -i も付ける（VS Code と同じ）。nix の設定を ~/.zshrc などに書いている人もいるため。
    // 標準入力は閉じ、プロファイルが出す文字は印で切り分ける。
    let mut cmd = Command::new(shell);
    cmd.args(["-l", "-i", "-c"])
        .arg(format!("printf '{PATH_MARKER}%s{PATH_MARKER}' \"$PATH\""))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // 時間切れのとき、プロファイルが起こした子孫ごと止められるよう、新しいプロセスグループにする
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        // EOF を待たず、閉じる側の印が来た時点で答える（標準出力を握ったままの子孫が残っても待たない）
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
            if let Some(p) = parse_marked_path(&String::from_utf8_lossy(&buf)) {
                let _ = tx.send(p);
                return;
            }
        }
    });
    let out = rx.recv_timeout(timeout).ok();
    kill_group(&mut child);
    out.map(OsString::from)
}

/// child とそのプロセスグループ（プロファイルが起こした子孫）を止めて、片付ける。
fn kill_group(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{}", child.id())])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// `…@@shj-path@@<PATH>@@shj-path@@…` から PATH を取り出す（プロファイルの出力が前後にあってもよい）。
fn parse_marked_path(out: &str) -> Option<String> {
    let start = out.rfind(PATH_MARKER)?;
    let before = &out[..start];
    let open = before.rfind(PATH_MARKER)?;
    let path = &before[open + PATH_MARKER.len()..];
    (!path.is_empty()).then(|| path.to_string())
}

/// [`COMMON_DIRS`] の `$HOME` と `$USER` を置き換える。分からないものを含む場所は外す。
fn expand_common_dirs(home: Option<&str>, user: Option<&str>) -> Vec<PathBuf> {
    COMMON_DIRS
        .iter()
        .filter_map(|d| {
            let mut s = d.to_string();
            for (var, val) in [("$HOME", home), ("$USER", user)] {
                if s.contains(var) {
                    s = s.replace(var, val.filter(|v| !v.is_empty())?);
                }
            }
            Some(PathBuf::from(s))
        })
        .collect()
}

/// 前から順に、重なりを除いてつなげた PATH。
fn merge_paths<'a>(parts: impl IntoIterator<Item = &'a OsStr>, extra: &[PathBuf]) -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let all = parts
        .into_iter()
        .flat_map(|p| std::env::split_paths(p).collect::<Vec<_>>())
        .chain(extra.iter().cloned());
    for d in all {
        if !d.as_os_str().is_empty() && !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// PATH の中から、実行できる name を探す。
fn find_in_path(path: &OsStr, name: &str) -> Option<PathBuf> {
    std::env::split_paths(path)
        .map(|d| d.join(name))
        .find(|p| is_executable(p))
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

/// GUI の版が nightly（`X.Y.Z-nightly.<日付>.<sha>`）なら、`(X.Y.Z, Some(sha))`。安定版（`X.Y.Z`）なら `(X.Y.Z, None)`。
/// それ以外の形なら None。
pub(crate) fn split_version(v: &str) -> Option<(&str, Option<&str>)> {
    let is_xyz = |s: &str| {
        let parts: Vec<&str> = s.split('.').collect();
        parts.len() == 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
    };
    if let Some((base, rest)) = v.split_once("-nightly.") {
        let (_date, sha) = rest.split_once('.')?;
        let ok_sha = sha.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        return (is_xyz(base) && ok_sha).then_some((base, Some(sha)));
    }
    is_xyz(v).then_some((v, None))
}

/// PATH などで探す shj の名前。nightly の shj は `shj-nightly` の名前で入る（flake.nix・packaging/npm/pack.sh）。
fn shj_names(gui_version: &str) -> &'static [&'static str] {
    match split_version(gui_version) {
        Some((_, Some(_))) => &["shj-nightly", "shj"],
        _ => &["shj"],
    }
}

/// GUI と同じ版の shj が `shj --version` で出す文字列に合う、sh の `case` のパターン。
/// 安定版 `0.7.0` は `shijimi v0.7.0`（後ろにコミット ` (abc1234)` が付いてもよい）、
/// nightly `0.7.0-nightly.20261101.abc1234` は `shijimi v0.7.0-nightly (abc1234…)`（コミットまで同じ）。
/// 版の形が分からなければ None（キャッシュ以外は使わない）。
fn version_case_pattern(gui_version: &str) -> Option<String> {
    let (base, sha) = split_version(gui_version)?;
    Some(match sha {
        None => format!("\"shijimi v{base}\"|\"shijimi v{base} (\"*"),
        Some("") => format!("\"shijimi v{base}-nightly\"|\"shijimi v{base}-nightly (\"*"),
        Some(sha) => {
            // shj はコミットを 7 文字に切って出す
            let short: String = sha.chars().take(7).collect();
            format!("\"shijimi v{base}-nightly ({short}\"*")
        }
    })
}

/// 「このマシン」の shj を起動するコマンド（引数はまだ付けない）。
/// `SHIJIMI_SHJ` があればそれを使う。無ければ、ログインシェルの PATH・GUI の PATH・よく使う場所の順に探す。
/// 見つからなければ `shj` のまま（起動に失敗し、画面は「つなげませんでした」を出す）。
/// 「このマシン」には入れる手段が無いので、版は確かめない（違えば `session.hello` で分かる）。
pub fn local_shj_command(gui_version: &str) -> Command {
    let home = std::env::var("HOME").ok();
    let user = std::env::var("USER").ok();
    let gui_path = std::env::var_os("PATH");
    let path = merge_paths(
        login_shell_path()
            .map(OsString::as_os_str)
            .into_iter()
            .chain(gui_path.as_deref()),
        &expand_common_dirs(home.as_deref(), user.as_deref()),
    );
    let shj = std::env::var_os("SHIJIMI_SHJ")
        .or_else(|| {
            shj_names(gui_version)
                .iter()
                .find_map(|n| find_in_path(&path, n))
                .map(PathBuf::into_os_string)
        })
        .unwrap_or_else(|| "shj".into());
    let mut c = Command::new(shj);
    c.env("PATH", path);
    c
}

/// ssh 先で動かす `shj attach`（POSIX sh のスクリプト。単一引用符と `\` は含まない）。
/// 1. GUI の版のキャッシュ（`cache_rel`、`$HOME` からの相対）があれば、それを使う。
/// 2. 無ければ、PATH、次に `dirs`（`$HOME`・`$USER` を使える。普段は [`COMMON_DIRS`]）の shj のうち、
///    `--version` が GUI の版と同じものを使う（版の違う shj や、`attach` を持たない古い shj は使わない）。
/// 3. どれも無ければ `exit_missing` で終わる（画面は GUI と同じ版を入れるかを聞く。C6・設計書 3 章）。
pub fn remote_attach_script(
    cache_rel: &str,
    gui_version: &str,
    dirs: &[&str],
    exit_missing: i32,
) -> String {
    let mut s =
        format!("c=\"$HOME/{cache_rel}/shj\"; if [ -x \"$c\" ]; then exec \"$c\" attach; fi; ");
    if let Some(pat) = version_case_pattern(gui_version) {
        let names = shj_names(gui_version);
        let mut cands: Vec<String> = names
            .iter()
            .map(|n| format!("\"$(command -v {n} 2>/dev/null)\""))
            .collect();
        for d in dirs {
            let d = d.replace("$USER", "$u");
            cands.extend(names.iter().map(|n| format!("\"{d}/{n}\"")));
        }
        s.push_str(&format!(
            "u=${{USER:-$(id -un)}}; \
             for s in {cands}; do \
             if [ -x \"$s\" ]; then \
             case \"$(\"$s\" --version 2>/dev/null </dev/null)\" in {pat}) exec \"$s\" attach;; esac; \
             fi; done; ",
            cands = cands.join(" "),
        ));
    }
    s.push_str(&format!("exit {exit_missing}"));
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn marked_path_ignores_profile_noise() {
        assert_eq!(
            parse_marked_path("Welcome!\n@@shj-path@@/a/bin:/b/bin@@shj-path@@\nbye\n").as_deref(),
            Some("/a/bin:/b/bin")
        );
        assert_eq!(parse_marked_path("/a/bin:/b/bin"), None);
        assert_eq!(parse_marked_path("@@shj-path@@@@shj-path@@"), None);
        assert_eq!(parse_marked_path("@@shj-path@@/a"), None);
    }

    #[cfg(unix)]
    fn temp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("shj-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[cfg(unix)]
    fn write_exe(p: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// ログインシェルの代わりの偽物（/bin/sh のスクリプト）で、取れる・時間切れ・取れないを確かめる。
    #[cfg(unix)]
    #[test]
    fn login_shell_path_with_fake_shells() {
        let root = temp_root("login");
        let t = Duration::from_secs(5);

        // 雑音のあとに印を出す（-l -i -c <cmd> の <cmd> を sh で動かす）
        let noisy = root.join("noisy");
        write_exe(
            &noisy,
            "#!/bin/sh\necho Welcome\nPATH=/x/bin:/y/bin\nexport PATH\neval \"$4\"\necho bye\n",
        );
        assert_eq!(
            ask_login_shell_path(&noisy, t),
            Some(OsString::from("/x/bin:/y/bin"))
        );

        // 標準出力を握ったままの子孫を残しても、印が来た時点で答える
        let daemon = root.join("daemon");
        write_exe(
            &daemon,
            "#!/bin/sh\nsleep 30 &\nPATH=/d/bin\nexport PATH\neval \"$4\"\n",
        );
        let start = Instant::now();
        assert_eq!(
            ask_login_shell_path(&daemon, t),
            Some(OsString::from("/d/bin"))
        );
        assert!(start.elapsed() < Duration::from_secs(3));

        // 止まるシェルは時間切れで諦める
        let hang = root.join("hang");
        write_exe(&hang, "#!/bin/sh\nexec sleep 30\n");
        let start = Instant::now();
        assert_eq!(
            ask_login_shell_path(&hang, Duration::from_millis(300)),
            None
        );
        assert!(start.elapsed() < Duration::from_secs(3));

        // 印を出さずに終わる・無いシェル・相対パス
        let quiet = root.join("quiet");
        write_exe(&quiet, "#!/bin/sh\necho nothing\n");
        assert_eq!(ask_login_shell_path(&quiet, t), None);
        assert_eq!(ask_login_shell_path(&root.join("missing"), t), None);
        assert_eq!(ask_login_shell_path(Path::new("sh"), t), None);

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn common_dirs_cover_nix_and_homebrew() {
        let d = expand_common_dirs(Some("/Users/me"), Some("me"));
        for want in [
            "/Users/me/.nix-profile/bin",
            "/etc/profiles/per-user/me/bin",
            "/run/current-system/sw/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/Users/me/.local/bin",
        ] {
            assert!(d.contains(&PathBuf::from(want)), "{want} missing");
        }
        // HOME や USER が分からなければ、その場所は外す（`/.nix-profile/bin` などにしない）
        let d = expand_common_dirs(None, Some(""));
        assert!(d.iter().all(|p| !p.to_string_lossy().contains('$')));
        assert!(!d.contains(&PathBuf::from("/.nix-profile/bin")));
        assert!(!d.contains(&PathBuf::from("/etc/profiles/per-user//bin")));
        assert!(d.contains(&PathBuf::from("/run/current-system/sw/bin")));
    }

    #[test]
    fn merge_keeps_order_and_drops_duplicates() {
        let p = merge_paths(
            [
                OsStr::new("/login/bin:/usr/bin"),
                OsStr::new("/usr/bin:/bin"),
            ],
            &[PathBuf::from("/login/bin"), PathBuf::from("/extra")],
        );
        assert_eq!(p, OsString::from("/login/bin:/usr/bin:/bin:/extra"));
    }

    #[cfg(unix)]
    #[test]
    fn finds_only_executables() {
        let dir = temp_root("locate");
        let a = dir.join("a");
        let b = dir.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("shj"), "").unwrap(); // 実行できない
        write_exe(&b.join("shj"), "");
        let path = std::env::join_paths([&a, &b]).unwrap();
        assert_eq!(find_in_path(&path, "shj"), Some(b.join("shj")));
        assert_eq!(find_in_path(&path, "nope"), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn version_patterns() {
        assert_eq!(split_version("0.7.0"), Some(("0.7.0", None)));
        assert_eq!(
            split_version("0.7.0-nightly.20261101.abc1234"),
            Some(("0.7.0", Some("abc1234")))
        );
        assert_eq!(split_version("0.7"), None);
        assert_eq!(split_version("0.7.0-rc1"), None);
        assert_eq!(shj_names("0.7.0"), &["shj"]);
        assert_eq!(
            shj_names("0.7.0-nightly.20261101.abc1234"),
            &["shj-nightly", "shj"]
        );
        assert_eq!(
            version_case_pattern("0.7.0").unwrap(),
            "\"shijimi v0.7.0\"|\"shijimi v0.7.0 (\"*"
        );
        assert_eq!(
            version_case_pattern("0.7.0-nightly.20261101.abc1234def").unwrap(),
            "\"shijimi v0.7.0-nightly (abc1234\"*"
        );
        assert_eq!(version_case_pattern("weird"), None);
    }

    #[test]
    fn remote_script_has_no_quotes_and_prefers_the_cache() {
        for v in ["1.2.3", "1.2.3-nightly.20261101.abc1234"] {
            let s = remote_attach_script(".cache/shijimi-editor/1.2.3", v, COMMON_DIRS, 97);
            // sh -c '…' で包むので単一引用符は使えない。fish の単一引用符の中で意味を持つ \ も避ける
            assert!(!s.contains('\'') && !s.contains('\\'), "{s}");
            let cache = s.find("$HOME/.cache/shijimi-editor/1.2.3/shj").unwrap();
            let path = s.find("command -v shj").unwrap();
            let nix = s.find("\"$HOME/.nix-profile/bin/shj").unwrap();
            assert!(cache < path && path < nix);
            assert!(s.contains("\"/etc/profiles/per-user/$u/bin/shj\""));
            assert!(s.contains("--version"));
            assert!(s.ends_with("exit 97"));
        }
        // 版の形が分からなければ、キャッシュだけを見る
        let s = remote_attach_script(".cache/x", "weird", COMMON_DIRS, 97);
        assert!(!s.contains("command -v") && s.ends_with("exit 97"));
    }

    /// 書いたスクリプトを本物の sh で動かす。探す場所は一時フォルダだけにする（開発機の shj に左右されない）。
    #[cfg(unix)]
    #[test]
    fn remote_script_runs_in_sh() {
        let root = temp_root("remote");
        let home = root.join("home");
        let dirs_owned = [
            format!("{}/nixprof/bin", root.display()),
            format!("{}/peruser/$USER/bin", root.display()),
        ];
        let dirs: Vec<&str> = dirs_owned.iter().map(String::as_str).collect();
        // --version には ver を返し、それ以外の引数には「tag 引数」を出す偽の shj
        let fake = |p: &Path, tag: &str, ver: &str| {
            write_exe(
                p,
                &format!(
                    "#!/bin/sh\nif [ \"$1\" = --version ]; then echo \"{ver}\"; exit 0; fi\necho {tag} \"$1\"\n"
                ),
            );
        };
        let run = |gui: &str, path: &str| {
            let script = remote_attach_script(".cache/shijimi-editor/1.2.3", gui, &dirs, 97);
            Command::new("/bin/sh")
                .arg("-c")
                .arg(&script)
                .env_clear()
                .env("HOME", &home)
                .env("USER", "me")
                .env("PATH", path)
                .output()
                .unwrap()
        };
        let stdout = |o: std::process::Output| String::from_utf8_lossy(&o.stdout).into_owned();
        let sys = "/usr/bin:/bin";
        let onpath = root.join("onpath");
        let with_path = format!("{}:{sys}", onpath.display());

        // どこにも無い
        assert_eq!(run("1.2.3", sys).status.code(), Some(97));

        // 版の違う shj（attach を持たない古い shj も同じ）しか無ければ 97（入れるかを聞く）
        fake(&onpath.join("shj"), "old", "shijimi v1.2.2 (aaaaaaa)");
        fake(&root.join("nixprof/bin/shj"), "old", "shijimi v1.2.2");
        assert_eq!(run("1.2.3", &with_path).status.code(), Some(97));

        // よく使う場所（$USER 入り）に同じ版があれば、PATH の違う版を飛ばしてそれを使う
        fake(
            &root.join("peruser/me/bin/shj"),
            "hm",
            "shijimi v1.2.3 (bbbbbbb)",
        );
        assert_eq!(stdout(run("1.2.3", &with_path)), "hm attach\n");

        // PATH に同じ版があれば、よく使う場所より先
        fake(&onpath.join("shj"), "path", "shijimi v1.2.3");
        assert_eq!(stdout(run("1.2.3", &with_path)), "path attach\n");

        // nightly の GUI は、同じコミットの shj-nightly だけを使う（安定版の shj や別の日の nightly は使わない）
        let nightly = "1.2.3-nightly.20261101.ccccccc";
        assert_eq!(run(nightly, &with_path).status.code(), Some(97));
        fake(
            &onpath.join("shj-nightly"),
            "other-day",
            "shijimi v1.2.3-nightly (ddddddd)",
        );
        assert_eq!(run(nightly, &with_path).status.code(), Some(97));
        fake(
            &root.join("nixprof/bin/shj-nightly"),
            "nightly",
            "shijimi v1.2.3-nightly (ccccccc)",
        );
        assert_eq!(stdout(run(nightly, &with_path)), "nightly attach\n");

        // GUI の版のキャッシュが一番先（版は確かめない。入れたときに SHA-256 で確かめている）
        fake(&home.join(".cache/shijimi-editor/1.2.3/shj"), "cache", "x");
        assert_eq!(stdout(run("1.2.3", &with_path)), "cache attach\n");

        std::fs::remove_dir_all(&root).unwrap();
    }
}
