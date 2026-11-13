//! リモートに kisui と shj を入れる（C6）。設計書 3 章「ssh 越しに kisui を起動する」の 1。
//!
//! 信頼の境目（ここを変えるときは設計書と PR の説明を読み直す）:
//!  - 呼ぶ前に、画面がユーザーに聞く。ここは聞かない（聞かずに呼ばれないことは画面側が守る）。
//!  - 入れる先は `~/.cache/kisui-terminal/<GUI の版>/` の `kisui` と、同じ版の `shj`（欄の中で先に使う。kisui が隣の shj を PATH の先頭に足す）だけ。PATH の `kisui` には触らない。
//!    ペインのシェルが起動するのは、kisui serve が今の版に向け直す `~/.cache/kisui-terminal/current/` のリンク（版を上げても、前から開いているシェルが新しい版を使うように。`server/current.go`）。
//!  - 取ってくるのは GitHub Releases の固定の URL（`https` のみ、リダイレクトも `https` のみ）。
//!  - 取った実行ファイルは、同じ Release の `SHA256SUMS` の値と合わなければ、ssh を起動する前に捨てる。
//!  - 送ったあと、リモートで SHA-256 を計り直し、同じ値のときだけ実行できる名前にする（合わなければ消す）。

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::askpass::AskpassServer;
use crate::connection::{cache_dir_rel, default_remote_kisui, ssh_command};

const REPO_URL: &str = "https://github.com/mm1995tk/kisui-terminal";
/// checksums のファイル名（リリースと nightly の両方に上げる）。
pub const CHECKSUMS_NAME: &str = "SHA256SUMS";
/// リモートの SHA-256 が合わなかったときの終了コード。
const EXIT_CHECKSUM_MISMATCH: i32 = 98;
/// kisui（Go の静的な実行ファイル）の上限。これを超えるものは受けつけない。
const MAX_BINARY: u64 = 200 * 1024 * 1024;
const MAX_CHECKSUMS: u64 = 1024 * 1024;
const MARKER: &str = "@@shj-uname@@";

/// 入れる前に画面がユーザーに見せる内容。
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct InstallPlan {
    /// GUI の版
    pub version: String,
    /// リモートに置く場所（`~` はリモートのシェルが展開する）
    pub path: String,
    /// 取ってくる Release のページ
    pub release_url: String,
}

/// 入れ終わった結果。
#[derive(Serialize, Clone, Debug)]
pub struct InstallResult {
    /// 入れた場所（`~` はリモートのシェルが展開する）
    pub path: String,
    /// 取った Release のアセット名（`kisui-linux-x64` など）
    pub asset: String,
    /// 確かめた SHA-256（16 進、小文字）。取得の段階とリモートの両方でこの値と合った
    pub sha256: String,
}

/// 版に使える文字だけか。リモートのスクリプトと URL に入れるので、記号は `. + -` に限る。
fn valid_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && !v.starts_with('-')
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'))
}

/// nightly 版の GUI かどうか（版が `X.Y.Z-nightly.<日付>.g<sha>`）。
fn is_nightly(version: &str) -> bool {
    version.contains("-nightly")
}

/// GUI の Release のタグ。安定版は `v<版>`、nightly 版は動くタグ `nightly`（どちらも kisui-terminal のリポジトリ。
/// kisui と、同梱した shj はそこから取る。shj のリポジトリの Release は見ない）。
fn release_tag(version: &str) -> String {
    if is_nightly(version) {
        "nightly".to_string()
    } else {
        format!("v{version}")
    }
}

/// `uname -sm` の結果から、Release の実行ファイル名（`<tool>-<os>-<cpu>`、nightly は `<tool>-nightly-<os>-<cpu>`）を決める。
/// tool は `kisui` か `shj`。macOS の Intel（Darwin x86_64）は作っていないので Err。
fn asset_name(tool: &str, version: &str, uname: &str) -> Result<String, String> {
    let mut it = uname.split_whitespace();
    let (os, machine) = match (it.next(), it.next(), it.next()) {
        (Some(o), Some(m), None) => (o, m),
        _ => return Err(format!("unexpected uname output: {uname:?}")),
    };
    let os = match os {
        "Linux" => "linux",
        "Darwin" => "darwin",
        _ => return Err(format!("unsupported OS: {os}")),
    };
    let cpu = match machine {
        "x86_64" | "amd64" => "x64",
        "aarch64" | "arm64" => "arm64",
        _ => return Err(format!("unsupported CPU: {machine}")),
    };
    if os == "darwin" && cpu == "x64" {
        return Err("unsupported: kisui-terminal does not support macOS on Intel (x86_64); only Apple silicon (arm64)".to_string());
    }
    Ok(if is_nightly(version) {
        format!("{tool}-nightly-{os}-{cpu}")
    } else {
        format!("{tool}-{os}-{cpu}")
    })
}

fn asset_url(version: &str, name: &str) -> String {
    format!(
        "{REPO_URL}/releases/download/{}/{name}",
        release_tag(version)
    )
}

/// ユーザーに聞くときに見せる内容（版・入れる場所・Release のページ）を作る。
/// 版が URL とリモートのスクリプトに入れられる文字でなければ Err。
pub fn plan() -> Result<InstallPlan, String> {
    let version = crate::version::get();
    if !valid_version(version) {
        return Err(format!("invalid GUI version: {version:?}"));
    }
    Ok(InstallPlan {
        version: version.to_string(),
        path: default_remote_kisui(),
        release_url: format!("{REPO_URL}/releases/tag/{}", release_tag(version)),
    })
}

/// `SHA256SUMS`（`sha256sum` の出力。`<64 桁の 16 進>  <名前>`）から name の値を取る。
/// 無い、または名前が重なって値が食い違うときはエラー。
fn checksum_for(sums: &str, name: &str) -> Result<String, String> {
    let mut found: Option<String> = None;
    for line in sums.lines() {
        let Some((hash, rest)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let file = rest.trim_start().trim_start_matches('*');
        if file != name {
            continue;
        }
        if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!("malformed checksum for {name}"));
        }
        let hash = hash.to_ascii_lowercase();
        match &found {
            Some(h) if *h != hash => return Err(format!("conflicting checksums for {name}")),
            _ => found = Some(hash),
        }
    }
    found.ok_or_else(|| format!("{name} is not listed in {CHECKSUMS_NAME}"))
}

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// https の URL を取る。システムの curl を使う（ssh と同じく、ユーザーの環境の証明書とプロキシが効く）。
/// `-q` は ~/.curlrc を読ませない。`--proto` は https 以外とリダイレクト先を断る。
fn fetch(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let out = Command::new("curl")
        .args([
            "-q",
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--connect-timeout",
            "20",
            "--max-time",
            "600",
            "--max-filesize",
        ])
        .arg(limit.to_string())
        .arg("--")
        .arg(url)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run curl: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "download failed: {url}\n{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    if out.stdout.len() as u64 > limit {
        return Err(format!("download too large: {url}"));
    }
    Ok(out.stdout)
}

/// 取得の段階：実行ファイルと SHA256SUMS を取り、値が合うことを確かめる。合わなければ Err（実行ファイルは返さない）。
fn download_verified(version: &str, asset: &str) -> Result<(Vec<u8>, String), String> {
    let sums = fetch(&asset_url(version, CHECKSUMS_NAME), MAX_CHECKSUMS)?;
    let sums = String::from_utf8(sums).map_err(|_| format!("{CHECKSUMS_NAME} is not UTF-8"))?;
    let expected = checksum_for(&sums, asset)?;
    let bin = fetch(&asset_url(version, asset), MAX_BINARY)?;
    verify(&bin, &expected, asset)?;
    Ok((bin, expected))
}

fn verify(bin: &[u8], expected: &str, asset: &str) -> Result<(), String> {
    let actual = sha256_hex(bin);
    if actual != expected {
        return Err(format!(
            "SHA-256 mismatch for {asset}: expected {expected}, got {actual}. Nothing was installed."
        ));
    }
    Ok(())
}

/// リモートで動かすスクリプト（`sh -c` に 1 引数で渡す）。標準入力の実行ファイルを一時ファイルに受け、
/// SHA-256 を計り直して、expected と同じときだけ実行できる名前にする。シングルクォートを含めない
/// （外側のログインシェルが何であっても、そのまま囲めるように）。version と expected は検査済みの文字だけ。
fn remote_script(version: &str, tool: &str, expected: &str) -> String {
    format!(
        concat!(
            "set -eu; ",
            "d=\"$HOME/{dir}\"; ",
            "mkdir -p \"$d\"; ",
            // umask 002 のホストでもグループとほかの人が書けないようにする（kisui serve の版によらないフォルダ `current` の確かめ。server/current.go）
            "chmod go-w \"$d\" \"${{d%/*}}\"; ",
            "t=\"$d/.{tool}.$$\"; ",
            "cat > \"$t\" || {{ rm -f \"$t\"; exit 1; }}; ",
            "h=$( (sha256sum \"$t\" 2>/dev/null || shasum -a 256 \"$t\") | cut -d \" \" -f1 ); ",
            "if [ \"$h\" != \"{expected}\" ]; then rm -f \"$t\"; echo \"SHA-256 mismatch on the remote: $h\" >&2; exit {mismatch}; fi; ",
            "chmod 755 \"$t\"; ",
            "mv -f \"$t\" \"$d/{tool}\""
        ),
        dir = cache_dir_rel(version),
        tool = tool,
        expected = expected,
        mismatch = EXIT_CHECKSUM_MISMATCH
    )
}

fn remote_install_command(version: &str, tool: &str, expected: &str) -> String {
    format!("sh -c '{}'", remote_script(version, tool, expected))
}

/// `uname -sm` の出力から、目印の行の後ろを取る（ログインシェルが motd などを出しても混ざらないように）。
fn parse_uname(out: &str) -> Option<String> {
    out.lines()
        .filter_map(|l| l.trim().strip_prefix(MARKER))
        .map(|r| r.trim().to_string())
        .next_back()
        .filter(|u| !u.is_empty())
}

fn remote_uname(target: &str, ask: &AskpassServer, id: &str) -> Result<String, String> {
    let cmd = format!("printf '\\n%s ' {MARKER}; uname -sm");
    let out = ssh_command(target, ask, id, &cmd)?
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run ssh: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ssh failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    parse_uname(&String::from_utf8_lossy(&out.stdout))
        .ok_or_else(|| "could not read uname -sm from the remote".to_string())
}

/// リモートに kisui を入れる。ユーザーに聞いたあとにだけ呼ぶ。時間がかかるので別スレッドで呼ぶこと。
pub fn install(target: &str, ask: &AskpassServer, id: &str) -> Result<InstallResult, String> {
    let r = install_inner(target, ask, id);
    // 終わったあとに残った質問（ssh が先に終わったときなど）を片付ける
    ask.cancel_conn(id);
    ask.forget(id);
    r
}

fn install_inner(target: &str, ask: &AskpassServer, id: &str) -> Result<InstallResult, String> {
    if std::env::var_os("SHIJIMI_REMOTE_KISUI").is_some() {
        // 場所を手で指定しているときは、その場所に何があるか分からない。入れない。
        return Err("SHIJIMI_REMOTE_KISUI is set; refusing to install".into());
    }
    let plan = plan()?;
    check_not_aborted(ask, id)?;
    let uname = remote_uname(target, ask, id)?;
    check_not_aborted(ask, id)?;
    // 2 つとも取って確かめてから、リモートに送る（どちらかが合わなければ、何も置かない）
    let shj_asset = asset_name("shj", &plan.version, &uname)?;
    let (shj_bin, shj_sum) = download_verified(&plan.version, &shj_asset)?;
    let asset = asset_name("kisui", &plan.version, &uname)?;
    let (bin, expected) = download_verified(&plan.version, &asset)?;
    check_not_aborted(ask, id)?;

    // kisui があることが「入っている」の印なので、shj を先に置く（途中で止まっても、kisui だけ残ることはない）
    send_one(target, ask, id, &plan.version, "shj", shj_bin, &shj_sum)?;
    check_not_aborted(ask, id)?;
    send_one(target, ask, id, &plan.version, "kisui", bin, &expected)?;
    Ok(InstallResult {
        path: plan.path,
        asset,
        sha256: expected,
    })
}

/// 実行ファイル 1 つ（tool は `kisui` か `shj`）をリモートのキャッシュに送り、リモートで SHA-256 を計り直して置く。
fn send_one(
    target: &str,
    ask: &AskpassServer,
    id: &str,
    version: &str,
    tool: &str,
    bin: Vec<u8>,
    expected: &str,
) -> Result<(), String> {
    let mut child = ssh_command(
        target,
        ask,
        id,
        &remote_install_command(version, tool, expected),
    )?
    .stdin(Stdio::piped())
    .stdout(Stdio::null())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| format!("failed to run ssh: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    // 書くのと標準エラーを読むのは別スレッドで（ssh が先に終わっても、どちらも詰まらないように）
    let writer = std::thread::spawn(move || stdin.write_all(&bin).and_then(|_| stdin.flush()));
    let reader = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = stderr.read_to_end(&mut s);
        String::from_utf8_lossy(&s).trim().to_string()
    });
    // 「切る」が押されたら ssh を殺す（途中のファイルはリモートの一時ファイルに残りうるが、実行できる名前にはならない）
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if ask.is_aborted(id) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = writer.join();
                let _ = reader.join();
                return Err("cancelled".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("ssh failed: {e}")),
        }
    };
    let _ = writer.join();
    let stderr = reader.join().unwrap_or_default();
    if !status.success() {
        let why = if status.code() == Some(EXIT_CHECKSUM_MISMATCH) {
            "the file on the remote did not match the SHA-256 (it was removed)"
        } else {
            "installing failed"
        };
        return Err(format!("{why} ({tool}, {status}): {stderr}"));
    }
    Ok(())
}

/// 「切る」で取り消されていたら Err。
fn check_not_aborted(ask: &AskpassServer, id: &str) -> Result<(), String> {
    if ask.is_aborted(id) {
        Err("cancelled".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn versions_and_tags() {
        assert!(valid_version("0.7.0"));
        assert!(valid_version("0.7.0-nightly.20261101.abc1234"));
        assert!(!valid_version(""));
        assert!(!valid_version("-x"));
        assert!(!valid_version("1.0\"; rm -rf ~; \""));
        assert!(!valid_version("a/b"));
        assert_eq!(release_tag("0.7.0"), "v0.7.0");
        assert_eq!(release_tag("0.7.0-nightly.20261101.abc1234"), "nightly");
    }

    #[test]
    fn asset_names() {
        assert_eq!(
            asset_name("kisui", "0.7.0", "Linux x86_64").unwrap(),
            "kisui-linux-x64"
        );
        assert_eq!(
            asset_name("kisui", "0.7.0", "Linux aarch64").unwrap(),
            "kisui-linux-arm64"
        );
        assert_eq!(
            asset_name("kisui", "0.7.0", "Darwin arm64").unwrap(),
            "kisui-darwin-arm64"
        );
        // macOS の Intel はサポートしない
        let err = asset_name("kisui", "0.7.0", "Darwin x86_64").unwrap_err();
        assert!(err.contains("macOS on Intel"), "{err}");
        assert!(asset_name("shj", "0.7.0-nightly.1.a", "Darwin x86_64").is_err());
        assert_eq!(
            asset_name("kisui", "0.7.0-nightly.1.a", "Linux x86_64").unwrap(),
            "kisui-nightly-linux-x64"
        );
        assert!(asset_name("kisui", "0.7.0", "FreeBSD amd64").is_err());
        assert!(asset_name("kisui", "0.7.0", "Linux riscv64").is_err());
        assert!(asset_name("kisui", "0.7.0", "Linux").is_err());
        assert!(asset_name("kisui", "0.7.0", "Linux x86_64 extra").is_err());
        // shj も同じ決まり
        assert_eq!(
            asset_name("shj", "0.7.0", "Linux x86_64").unwrap(),
            "shj-linux-x64"
        );
        assert_eq!(
            asset_name("shj", "0.7.0-nightly.1.a", "Darwin arm64").unwrap(),
            "shj-nightly-darwin-arm64"
        );
    }

    #[test]
    fn urls_are_fixed_to_the_repo() {
        assert_eq!(
            asset_url("0.7.0", "kisui-linux-x64"),
            "https://github.com/mm1995tk/kisui-terminal/releases/download/v0.7.0/kisui-linux-x64"
        );
        assert_eq!(
            asset_url("0.7.0-nightly.1.a", CHECKSUMS_NAME),
            "https://github.com/mm1995tk/kisui-terminal/releases/download/nightly/SHA256SUMS"
        );
    }

    #[test]
    fn checksums_parse() {
        let sums = format!(
            "{H}  kisui-linux-x64\n{}  kisui-darwin-arm64\n",
            "f".repeat(64)
        );
        assert_eq!(checksum_for(&sums, "kisui-linux-x64").unwrap(), H);
        assert_eq!(
            checksum_for(&sums, "kisui-darwin-arm64").unwrap(),
            "f".repeat(64)
        );
        // バイナリモード（*）と大文字
        let upper = format!("{} *kisui-linux-x64\n", H.to_ascii_uppercase());
        assert_eq!(checksum_for(&upper, "kisui-linux-x64").unwrap(), H);
        // 名前は完全一致（前方一致で別の物を拾わない）
        assert!(checksum_for(&sums, "kisui-linux").is_err());
        assert!(checksum_for(&sums, "kisui-linux-arm64").is_err());
        // 壊れた値
        assert!(checksum_for("abc  kisui-linux-x64\n", "kisui-linux-x64").is_err());
        assert!(checksum_for(
            &format!("{}  kisui-linux-x64\n", "g".repeat(64)),
            "kisui-linux-x64"
        )
        .is_err());
        // 同じ名前で値が食い違う
        let dup = format!("{H}  a\n{}  a\n", "e".repeat(64));
        assert!(checksum_for(&dup, "a").is_err());
        // 同じ値の重複は許す
        assert!(checksum_for(&format!("{H}  a\n{H}  a\n"), "a").is_ok());
    }

    #[test]
    fn verify_rejects_a_mismatch() {
        // "abc" の SHA-256
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(sha256_hex(b"abc"), abc);
        assert!(verify(b"abc", abc, "x").is_ok());
        assert!(verify(b"abd", abc, "x").is_err());
        assert!(verify(b"", abc, "x").is_err());
    }

    #[test]
    fn remote_script_has_no_single_quote_and_checks_the_hash() {
        let s = remote_script("0.7.0", "kisui", H);
        assert!(!s.contains('\''));
        assert!(s.contains(&format!("\"$h\" != \"{H}\"")));
        assert!(s.contains("$HOME/.cache/kisui-terminal/0.7.0"));
        // 実行できる名前に変えるのは、比べたあと
        assert!(s.find("exit 98").unwrap() < s.find("mv -f").unwrap());
        // PATH の kisui には触らない
        assert!(!s.contains("/usr") && !s.contains("/bin/kisui") && !s.contains(".local"));
        assert!(remote_install_command("0.7.0", "kisui", H).starts_with("sh -c '"));
        // shj は同じキャッシュに、別の一時ファイルと名前で置く
        let s = remote_script("0.7.0", "shj", H);
        assert!(!s.contains('\''));
        assert!(s.contains("$d/.shj.$$") && s.contains("\"$d/shj\""));
        assert!(!s.contains("\"$d/kisui\"") && !s.contains(".kisui."));
    }

    #[test]
    fn uname_ignores_motd() {
        assert_eq!(
            parse_uname("Welcome!\n@@shj-uname@@ Linux x86_64\n").as_deref(),
            Some("Linux x86_64")
        );
        assert_eq!(parse_uname("Linux x86_64\n"), None);
        assert_eq!(parse_uname("@@shj-uname@@ \n"), None);
    }
}
