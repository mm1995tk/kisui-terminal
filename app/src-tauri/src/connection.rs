//! kisui への接続。`ssh -T host -- <kisui> attach`（リモート）か、`kisui attach` の直接起動（ローカル）を
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
use crate::relay;

/// 「ローカル」を表す接続先の名前。ssh のホスト名と取り違えないよう、`@` で始める（ホスト名には使えない）。
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
    format!(".cache/kisui-terminal/{version}")
}

/// 入れる先（`~/.cache/kisui-terminal/<GUI の版>/kisui`）。PATH の `kisui` ではない。
pub fn default_remote_kisui() -> String {
    format!("~/{}/kisui", cache_dir_rel(crate::version::get()))
}

/// ssh の引数に渡してよいホスト名か。`-` で始まるとオプションになり、空白や制御文字は別の引数に化ける。
pub fn valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 255
        && !h.starts_with('-')
        && !h.starts_with('@')
        && !h.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// kisui が無かったとき、リモートのシェルがこの終了コードで終わる。ssh は遠隔コマンドの終了コードをそのまま返すので、
/// 画面側は「ssh が失敗した」と「kisui が入っていない」を見分けられる（入れる前にユーザーに聞く。設計書 3 章）。
pub const EXIT_KISUI_MISSING: i32 = 97;

/// `ssh -T <host> -- <remote_command>` の土台。askpass の環境変数もここで付ける。
pub fn ssh_command(
    target: &str,
    ask: &AskpassServer,
    id: &str,
    remote_command: &str,
) -> Result<Command, String> {
    ssh_command_with(target, ask, id, &[], remote_command)
}

/// [`ssh_command`] に、ホスト名の前に置く ssh のオプション（`-o 名前=値` の並び）を足したもの。
fn ssh_command_with(
    target: &str,
    ask: &AskpassServer,
    id: &str,
    opts: &[&str],
    remote_command: &str,
) -> Result<Command, String> {
    if !valid_host(target) {
        return Err(format!("invalid host name: {target:?}"));
    }
    let mut c = Command::new("ssh");
    c.arg("-T")
        .args(opts)
        .args([target, "--"])
        .arg(remote_command);
    with_ssh_env(&mut c, ask, id)?;
    Ok(c)
}

/// `kisui relay` の ssh に付けるオプション。手元のマシンのスリープや経路の断で、ssh が FIN を受けずに切れても、
/// 30 秒ごとの問い合わせが 3 回続けて答えられなければ ssh が自分で終わり、relay.rs が切れたと分かる
/// （消した `ssh -N -L` にも付けていた）。
const RELAY_SSH_OPTS: &[&str] = &[
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
];

/// ssh の環境変数を付ける。askpass（質問を GUI の窓に出させる）と PATH。
/// PATH は `~/.ssh/config` の `ProxyCommand` や `Match exec` のコマンドを見つけられるよう、ログインシェルのものを足す（`locate::launch_path`）。
fn with_ssh_env(c: &mut Command, ask: &AskpassServer, id: &str) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    c.env("PATH", locate::launch_path())
        .env("SSH_ASKPASS", exe)
        // DISPLAY が無くても、端末が無くても askpass を使わせる（OpenSSH 8.4 以降）
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env(askpass::ENV_SOCK, &ask.sock)
        .env(askpass::ENV_TOKEN, &ask.token)
        .env(askpass::ENV_CONN, id);
    Ok(())
}

/// `SHIJIMI_REMOTE_KISUI` で場所を手で指定したときの `kisui <sub>`（`attach` か `relay`）。その場所だけを見る。
/// kisui が無ければ（実行できなければ）EXIT_KISUI_MISSING で終わる。
fn custom_kisui_command(kisui: &str, sub: &str) -> String {
    // command -v は、パス（~ も展開される）と PATH 上の名前（SHIJIMI_REMOTE_KISUI=kisui など）の両方を調べる
    format!("command -v {kisui} >/dev/null 2>&1 || exit {EXIT_KISUI_MISSING}; {kisui} {sub}")
}

/// 普段の `kisui <sub>`。GUI の版のキャッシュにある kisui だけを使う（locate.rs）。ログインシェルが fish などでも動くよう、`sh -c '…'` で包む。
fn default_kisui_command(version: &str, sub: &str) -> String {
    let script = locate::remote_kisui_script(&cache_dir_rel(version), sub, EXIT_KISUI_MISSING);
    format!("sh -c '{script}'")
}

/// リモートで実行する `kisui <sub>`（`attach` か `relay`）。
fn remote_kisui_command(sub: &str) -> String {
    match std::env::var("SHIJIMI_REMOTE_KISUI") {
        Ok(kisui) => custom_kisui_command(&kisui, sub),
        Err(_) => default_kisui_command(crate::version::get(), sub),
    }
}

fn build_command(target: &str, ask: &AskpassServer, id: &str) -> Result<Command, String> {
    if target == LOCAL {
        let mut c = locate::local_kisui_command();
        c.arg("attach");
        return Ok(c);
    }
    ssh_command(target, ask, id, &remote_kisui_command("attach"))
}

/// `kisui relay` を動かしている ssh（relay.rs）。止めるとき・終わったときに、その接続の askpass の待ちも取り消す。
struct SshRelay {
    child: Child,
    target: String,
    conn: String,
    ask: Arc<AskpassServer>,
    /// 標準エラー出力の最後の数行
    tail: Arc<Mutex<Vec<String>>>,
    err_thread: Option<std::thread::JoinHandle<()>>,
}

impl relay::Process for SshRelay {
    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.ask.cancel_conn(&self.conn);
    }

    fn describe(&mut self) -> String {
        let code = self.child.wait().ok().and_then(|s| s.code());
        if let Some(t) = self.err_thread.take() {
            let _ = t.join();
        }
        if code == Some(EXIT_KISUI_MISSING) {
            return format!(
                "kisui is not installed on {} (connect to the machine once to install it)",
                self.target
            );
        }
        let tail = self.tail.lock().unwrap().join("\n");
        let tail = tail.trim();
        if !tail.is_empty() {
            return tail.to_string();
        }
        match code {
            Some(c) => format!("ssh exited with code {c}"),
            None => "ssh ended".into(),
        }
    }
}

/// `ssh <target> -- <kisui> relay` を起こす（外部ブラウザで開くリモートのマシンの localhost の URL の中継。open_url.rs）。
/// ssh の起こし方・askpass・リモートの kisui の探し方は `kisui attach` と同じ。`conn` は askpass の質問の宛先。
pub fn spawn_relay(
    target: &str,
    ask: &Arc<AskpassServer>,
    conn: &str,
) -> Result<relay::Transport, String> {
    let mut cmd = ssh_command_with(
        target,
        ask,
        conn,
        RELAY_SSH_OPTS,
        &remote_kisui_command("relay"),
    )?;
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start ssh: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let tail: Arc<Mutex<Vec<String>>> = Arc::default();
    let err_thread = {
        let tail = Arc::clone(&tail);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).split(b'\n').map_while(Result::ok) {
                let mut t = tail.lock().unwrap();
                t.push(String::from_utf8_lossy(&line).into_owned());
                if t.len() > 5 {
                    t.remove(0);
                }
            }
        })
    };
    Ok(relay::Transport {
        reader: Box::new(stdout),
        writer: Box::new(stdin),
        process: Box::new(SshRelay {
            child,
            target: target.to_string(),
            conn: conn.to_string(),
            ask: Arc::clone(ask),
            tail,
            err_thread: Some(err_thread),
        }),
    })
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

    /// 接続を終わらせる（ssh / attach を殺す。リモートの kisui serve は止まらない）。
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
    fn attach_exits_97_without_kisui() {
        assert_eq!(
            custom_kisui_command("~/.cache/kisui-terminal/1.2.3/kisui", "attach"),
            "command -v ~/.cache/kisui-terminal/1.2.3/kisui >/dev/null 2>&1 || exit 97; ~/.cache/kisui-terminal/1.2.3/kisui attach"
        );
    }

    #[test]
    fn default_attach_is_wrapped_in_sh() {
        let c = default_kisui_command("1.2.3", "attach");
        assert!(c.starts_with("sh -c '") && c.ends_with("exit 97'"));
        // 包んだ中に単一引用符が無い（あれば引用が崩れる）
        assert_eq!(c.matches('\'').count(), 2);
        assert!(c.contains("$HOME/.cache/kisui-terminal/1.2.3/kisui"));
        assert!(c.contains("exit 97"));
    }

    /// `kisui relay` も、`kisui attach` と同じキャッシュの kisui を同じ包み方で起こす。
    #[test]
    fn relay_uses_the_same_kisui_as_attach() {
        let c = default_kisui_command("1.2.3", "relay");
        assert_eq!(
            c,
            default_kisui_command("1.2.3", "attach").replace("\" attach;", "\" relay;")
        );
        assert!(c.contains("exec \"$c\" relay;"));
        assert!(custom_kisui_command("kisui", "relay").ends_with("; kisui relay"));
    }
}
