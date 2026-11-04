//! shj への接続。`ssh -T host -- <shj> attach`（リモート）か、`shj attach` の直接起動（このマシン）を
//! 子プロセスとして持ち、その標準入出力を Web 画面（Client の Transport）に中継する。
//! プロトコルは解釈しない（1 行ずつ運ぶだけ）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::askpass::{self, AskpassServer};
use crate::locate;

/// 「このマシン」を表す接続先の名前。ssh のホスト名と取り違えないよう、`@` で始める（ホスト名には使えない）。
pub const LOCAL: &str = "@local";

#[derive(Serialize, Clone)]
struct LineEvent {
    id: String,
    line: String,
}

#[derive(Serialize, Clone)]
struct ClosedEvent {
    id: String,
    code: Option<i32>,
    /// ssh の標準エラー出力の最後の数行（つながらなかった理由の表示用）
    stderr: String,
}

struct Conn {
    child: Arc<Mutex<Child>>,
    stdin: Mutex<ChildStdin>,
}

/// 開いている接続（子プロセス）の表。
#[derive(Default)]
pub struct Connections {
    map: Arc<Mutex<HashMap<String, Arc<Conn>>>>,
}

/// 版ごとのキャッシュのフォルダ（`$HOME` からの相対）。つなぐ先（default_attach_command）と入れる先（install.rs）が
/// ずれないよう、ここ 1 か所で決める。
pub fn cache_dir_rel(version: &str) -> String {
    format!(".cache/shijimi-editor/{version}")
}

/// 入れる先（`~/.cache/shijimi-editor/<GUI の版>/shj`）。PATH の `shj` ではない。
pub fn default_remote_shj() -> String {
    format!("~/{}/shj", cache_dir_rel(crate::version::get()))
}

/// ssh の引数に渡してよいホスト名か。`-` で始まるとオプションになり、空白や制御文字は別の引数に化ける。
pub fn valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 255
        && !h.starts_with('-')
        && !h.starts_with('@')
        && !h.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// shj が無かったとき、リモートのシェルがこの終了コードで終わる。ssh は遠隔コマンドの終了コードをそのまま返すので、
/// 画面側は「ssh が失敗した」と「shj が入っていない」を見分けられる（入れる前にユーザーに聞く。設計書 3 章）。
pub const EXIT_SHJ_MISSING: i32 = 97;

/// `ssh -T <host> -- <remote_command>` の土台。askpass の環境変数もここで付ける。
pub fn ssh_command(
    target: &str,
    ask: &AskpassServer,
    id: &str,
    remote_command: &str,
) -> Result<Command, String> {
    if !valid_host(target) {
        return Err(format!("invalid host name: {target:?}"));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut c = Command::new("ssh");
    c.args(["-T", target, "--"])
        .arg(remote_command)
        .env("SSH_ASKPASS", exe)
        // DISPLAY が無くても、端末が無くても askpass を使わせる（OpenSSH 8.4 以降）
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env(askpass::ENV_SOCK, &ask.sock)
        .env(askpass::ENV_TOKEN, &ask.token)
        .env(askpass::ENV_CONN, id);
    Ok(c)
}

/// `SHIJIMI_REMOTE_SHJ` で場所を手で指定したときの `shj attach`。その場所だけを見る。
/// shj が無ければ（実行できなければ）EXIT_SHJ_MISSING で終わる。
fn custom_attach_command(shj: &str) -> String {
    // command -v は、パス（~ も展開される）と PATH 上の名前（SHIJIMI_REMOTE_SHJ=shj など）の両方を調べる
    format!("command -v {shj} >/dev/null 2>&1 || exit {EXIT_SHJ_MISSING}; {shj} attach")
}

/// 普段の `shj attach`。GUI の版のキャッシュ、PATH、よく使う場所（Nix のプロファイルなど）の順に、GUI と同じ版の shj を探す
/// （locate.rs）。ログインシェルが fish などでも動くよう、`sh -c '…'` で包む。
fn default_attach_command(version: &str) -> String {
    let script = locate::remote_attach_script(
        &cache_dir_rel(version),
        version,
        locate::COMMON_DIRS,
        EXIT_SHJ_MISSING,
    );
    format!("sh -c '{script}'")
}

/// リモートで実行する `shj attach`。
fn remote_attach_command() -> String {
    match std::env::var("SHIJIMI_REMOTE_SHJ") {
        Ok(shj) => custom_attach_command(&shj),
        Err(_) => default_attach_command(crate::version::get()),
    }
}

fn build_command(target: &str, ask: &AskpassServer, id: &str) -> Result<Command, String> {
    if target == LOCAL {
        let mut c = locate::local_shj_command(crate::version::get());
        c.arg("attach");
        return Ok(c);
    }
    ssh_command(target, ask, id, &remote_attach_command())
}

impl Connections {
    /// 子プロセスを起動し、出力の中継を始める。ssh が自分で終わったら、その接続の askpass の待ちも取り消す。
    pub fn open(
        &self,
        app: &AppHandle,
        ask: &Arc<AskpassServer>,
        id: String,
        target: &str,
    ) -> Result<(), String> {
        if id.is_empty() || id.len() > 64 {
            return Err("invalid connection id".into());
        }
        if self.map.lock().unwrap().contains_key(&id) {
            return Err("connection id already in use".into());
        }
        let mut cmd = build_command(target, &ask, &id)?;
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to start {:?}: {e}", cmd.get_program()))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let child = Arc::new(Mutex::new(child));
        let conn = Arc::new(Conn {
            child: Arc::clone(&child),
            stdin: Mutex::new(stdin),
        });
        self.map.lock().unwrap().insert(id.clone(), conn);

        // 標準エラーは最後の 20 行だけ覚える（プロトコルには混ぜない）
        let tail: Arc<Mutex<Vec<String>>> = Arc::default();
        let err_thread = {
            let tail = Arc::clone(&tail);
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).split(b'\n').map_while(Result::ok) {
                    let mut t = tail.lock().unwrap();
                    t.push(String::from_utf8_lossy(&line).into_owned());
                    if t.len() > 20 {
                        t.remove(0);
                    }
                }
            })
        };

        let app = app.clone();
        let map = Arc::clone(&self.map);
        let ask = Arc::clone(ask);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).split(b'\n').map_while(Result::ok) {
                let line = String::from_utf8_lossy(&line).into_owned();
                let _ = app.emit(
                    "shj-line",
                    LineEvent {
                        id: id.clone(),
                        line,
                    },
                );
            }
            let _ = err_thread.join();
            let code = child.lock().unwrap().wait().ok().and_then(|s| s.code());
            map.lock().unwrap().remove(&id); // 終わった後の send は失敗させる
            ask.cancel_conn(&id);
            let stderr = tail.lock().unwrap().join("\n");
            let _ = app.emit("shj-closed", ClosedEvent { id, code, stderr });
        });
        Ok(())
    }

    /// 1 メッセージ（末尾の改行は足す）を shj に送る。
    pub fn send(&self, id: &str, text: &str) -> Result<(), String> {
        let conn = self.get(id)?;
        let mut w = conn.stdin.lock().unwrap();
        w.write_all(text.as_bytes())
            .and_then(|_| w.write_all(b"\n"))
            .and_then(|_| w.flush())
            .map_err(|e| e.to_string())
    }

    /// 接続を終わらせる（ssh / attach を殺す。リモートの shj serve は止まらない）。
    pub fn close(&self, id: &str) {
        if let Some(conn) = self.map.lock().unwrap().remove(id) {
            let _ = conn.child.lock().unwrap().kill();
        }
    }

    /// 全部の接続を終わらせる（アプリの終了時）。
    pub fn close_all(&self) {
        let ids: Vec<String> = self.map.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }

    fn get(&self, id: &str) -> Result<Arc<Conn>, String> {
        self.map
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "no such connection".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_validation() {
        assert!(valid_host("web1"));
        assert!(valid_host("user@host.example"));
        assert!(!valid_host("-oProxyCommand=x"));
        assert!(!valid_host("a b"));
        assert!(!valid_host(""));
        assert!(!valid_host(LOCAL));
    }

    #[test]
    fn attach_exits_97_without_shj() {
        assert_eq!(
            custom_attach_command("~/.cache/shijimi-editor/1.2.3/shj"),
            "command -v ~/.cache/shijimi-editor/1.2.3/shj >/dev/null 2>&1 || exit 97; ~/.cache/shijimi-editor/1.2.3/shj attach"
        );
    }

    #[test]
    fn default_attach_is_wrapped_in_sh() {
        let c = default_attach_command("1.2.3");
        assert!(c.starts_with("sh -c '") && c.ends_with("exit 97'"));
        // 包んだ中に単一引用符が無い（あれば引用が崩れる）
        assert_eq!(c.matches('\'').count(), 2);
        assert!(c.contains("$HOME/.cache/shijimi-editor/1.2.3/shj"));
        assert!(c.contains("exit 97"));
    }
}
