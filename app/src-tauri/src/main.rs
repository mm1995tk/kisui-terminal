// Windows の release で黒い窓を出さない（対応 OS ではないが、害は無い）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod askpass;
mod config;
mod connection;
mod install;
mod locate;
mod notify;
mod ssh_config;
mod transfer;
mod update;
mod version;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Manager, RunEvent, State};

use askpass::AskpassServer;
use connection::Connections;

struct AppState {
    conns: Connections,
    askpass: Arc<AskpassServer>,
}

/// `~/.ssh/config` のホスト一覧（「ローカル」は含まない。画面側で足す）。
#[tauri::command]
fn list_ssh_hosts() -> Vec<String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|h| ssh_config::list_hosts(&h))
        .unwrap_or_default()
}

/// 手元の設定ファイルの `[[gui.machines]]`。間違いがあれば「ファイル:行: 理由」を返す（画面は起動しない）。
#[tauri::command]
fn config_machines() -> Result<Vec<config::ConfigMachine>, String> {
    config::load_default()
}

/// shj につなぐ。`target` は ssh のホスト名か `@local`。`id` は画面側が決める（イベントの宛先）。
/// メインスレッドの外で動かす。「ローカル」は、ログインシェルが PATH を答えるのを待つことがある（locate.rs）
#[tauri::command(async)]
fn connect(
    app: tauri::AppHandle,
    state: State<AppState>,
    id: String,
    target: String,
) -> Result<(), String> {
    state.conns.open(&app, &state.askpass, id, &target)
}

/// プロトコルの 1 メッセージを送る。
#[tauri::command]
fn send(state: State<AppState>, id: String, text: String) -> Result<(), String> {
    state.conns.send(&id, &text)
}

/// 接続を閉じる（待っている ssh の質問も取り消す）。リモートの shj serve は止まらない。
#[tauri::command]
fn disconnect(state: State<AppState>, id: String) {
    state.askpass.cancel_conn(&id);
    state.conns.close(&id);
}

/// リモートに入れるものの説明（ユーザーに聞くときに見せる）。
#[tauri::command]
fn install_plan() -> Result<install::InstallPlan, String> {
    install::plan()
}

/// リモートに shj を入れる。画面がユーザーに聞いたあとにだけ呼ぶ（ここでは聞かない）。
/// `id` は askpass の質問の宛先（接続の id と同じ形）。
#[tauri::command]
async fn install_remote(
    state: State<'_, AppState>,
    id: String,
    target: String,
) -> Result<install::InstallResult, String> {
    if id.is_empty() || id.len() > 64 {
        return Err("invalid connection id".into());
    }
    let ask = Arc::clone(&state.askpass);
    tauri::async_runtime::spawn_blocking(move || install::install(&target, &ask, &id))
        .await
        .map_err(|e| e.to_string())?
}

/// 入れている最中の取り消し（「切る」）。待っている ssh の質問を消し、あとで来る質問（ssh のパスワードの聞き直し）も断り、
/// 転送中の ssh を殺す。入れる処理は `cancelled` で終わる（取得中の curl は終わるのを待つ）。
#[tauri::command]
fn install_cancel(state: State<AppState>, id: String) {
    state.askpass.abort_conn(&id);
}

/// ssh の質問（askpass）への答え。`None` は取り消し。
#[tauri::command]
fn askpass_reply(state: State<AppState>, request_id: u64, value: Option<String>) {
    state.askpass.reply(request_id, value);
}

fn main() {
    // ssh が SSH_ASKPASS としてこの実行ファイルを起動したときは、窓を出さず質問を本体に中継する。
    if std::env::var_os(askpass::ENV_SOCK).is_some() {
        let prompt = std::env::args().nth(1).unwrap_or_default();
        std::process::exit(askpass::run_helper(&prompt));
    }

    let builder = tauri::Builder::default().plugin(tauri_plugin_clipboard_manager::init());
    // 自動更新（AppImage と .dmg の版だけ。update.rs）
    #[cfg(feature = "updater")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .manage(update::Updates::default())
        .manage(transfer::Transfers::default())
        .setup(|app| {
            version::init(app.package_info().version.to_string());
            // 「ローカル」の shj を探す PATH を、先にログインシェルに聞いておく（locate.rs）
            locate::warm_up();
            let askpass = AskpassServer::start(app.handle().clone())?;
            app.manage(AppState {
                conns: Connections::default(),
                askpass,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_ssh_hosts,
            config_machines,
            connect,
            send,
            disconnect,
            askpass_reply,
            install_plan,
            install_remote,
            install_cancel,
            notify::notify_show,
            transfer::transfer_dest,
            transfer::transfer_write_begin,
            transfer::transfer_write_open,
            transfer::transfer_write_chunk,
            transfer::transfer_write_end,
            transfer::transfer_write_close,
            transfer::transfer_read_list,
            transfer::transfer_read_approve,
            transfer::transfer_read_open,
            transfer::transfer_read_next,
            transfer::transfer_read_close,
            update::update_check,
            update::update_install
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the shijimi-editor GUI")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(s) = app.try_state::<AppState>() {
                    s.conns.close_all();
                    s.askpass.cleanup();
                }
            }
        });
}
