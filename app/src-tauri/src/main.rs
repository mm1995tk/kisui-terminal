// Windows の release で黒い窓を出さない（対応 OS ではないが、害は無い）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod askpass;
mod bookmarks;
mod browser;
#[cfg(target_os = "macos")]
mod browser_proxy;
mod clipboard_history;
mod clipboard_popup;
mod config;
mod connection;
mod download;
mod export;
mod favicon;
mod install;
mod locate;
mod mascot;
mod menu;
mod notify;
mod open_url;
mod passkey;
mod relay;
mod ssh_config;
mod transfer;
mod update;
mod version;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Manager, RunEvent, State, WindowEvent};

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

/// 手元の設定ファイル（config.toml に config.local.toml を重ねたもの）の `[[gui.machines]]` と `[gui.browser]`。
/// 間違いがあれば「ファイル:行: 理由」を返す（画面は起動しない）。
#[tauri::command]
fn config_gui() -> Result<config::GuiConfig, String> {
    config::load_default()
}

/// 画面の言葉（設定ファイルの `ui-language`。`"en"` か `"ja"`。無い・分からない値は `"en"`）。画面は起動時に 1 度だけ読む。
#[tauri::command]
fn ui_language() -> &'static str {
    config::ui_language_default()
}

/// kisui につなぐ。`target` は ssh のホスト名か `@local`。`id` は画面側が決める（イベントの宛先）。
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

/// 接続を閉じる（待っている ssh の質問も取り消す）。リモートの kisui serve は止まらない。
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

/// リモートに kisui を入れる。画面がユーザーに聞いたあとにだけ呼ぶ（ここでは聞かない）。
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

/// tauri の設定（tauri.conf.json）。内蔵ブラウザの DevTools（リーダーの `o i`。#205）のために tauri の feature `devtools` を入れて
/// いるので、release では、メイン窓（kisui-terminal の画面）の DevTools を切る（タブのページだけで使う。browser.rs の tab_builder）。
fn context() -> tauri::Context<tauri::Wry> {
    #[allow(unused_mut)]
    let mut ctx = tauri::generate_context!();
    #[cfg(not(debug_assertions))]
    for w in &mut ctx.config_mut().app.windows {
        w.devtools = Some(false);
    }
    ctx
}

fn main() {
    // ssh が SSH_ASKPASS としてこの実行ファイルを起動したときは、窓を出さず質問を本体に中継する。
    if std::env::var_os(askpass::ENV_SOCK).is_some() {
        let prompt = std::env::args().nth(1).unwrap_or_default();
        std::process::exit(askpass::run_helper(&prompt));
    }
    // 外のブラウザが native messaging の受け口として（登録のファイルの指すスクリプトから）起動したときは、窓を出さず、
    // 拡張機能のメッセージを動いている窓に中継する（passkey.rs）。
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() >= 3 && args[1] == passkey::HOST_FLAG {
        std::process::exit(passkey::run_host(std::path::Path::new(&args[2])));
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        // 結果の書き出しの保存のダイアログ（export.rs）。窓には許可を渡さない（capabilities に足さない）
        .plugin(tauri_plugin_dialog::init())
        // クリップボードの履歴を kisui-terminal の外から開く全体のキー（clipboard_popup.rs）
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());
    // 自動更新（AppImage と .dmg の版だけ。update.rs）
    #[cfg(feature = "updater")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        // リーダーの案内を運ぶキャラクターの画像（mascot.rs）。画面は `mascot_load` が付けた番号だけを渡す。
        // ファイルを読むので、メインスレッドの外で答える
        .register_asynchronous_uri_scheme_protocol(mascot::SCHEME, |ctx, req, responder| {
            let webview = ctx.webview_label().to_string();
            let path = req.uri().path().to_string();
            std::thread::spawn(move || responder.respond(mascot::respond(&webview, &path)));
        })
        .on_menu_event(|app, event| {
            if event.id() == menu::CLOSE_ID {
                menu::on_close(app);
            }
        })
        .manage(update::Updates::default())
        .manage(transfer::Transfers::default())
        .manage(browser::Tabs::default())
        .manage(download::Downloads::default())
        .setup(|app| {
            version::init(app.package_info().version.to_string());
            // 「ローカル」の kisui のターミナルに渡す PATH を、先にログインシェルに聞いておく（locate.rs）
            locate::warm_up();
            // クリップボードの履歴を読み込み、OS のクリップボードの見張りを始める（clipboard_history.rs）
            clipboard_history::start(app.handle());
            // 全体のキー（Option+Space・Alt+Space）で、履歴の小さな窓を出す（clipboard_popup.rs）
            clipboard_popup::start(app.handle());
            // Mac の「閉じる」（Cmd+W）を、今の欄を閉じる動きに差し替える（menu.rs）
            #[cfg(target_os = "macos")]
            menu::install(app.handle())?;
            let askpass = AskpassServer::start(app.handle().clone())?;
            // リモートのマシンの localhost の URL を開く中継（open_url.rs・relay.rs）
            app.manage(open_url::Forwards::new(Arc::clone(&askpass)));
            // パスキーのときに外のブラウザへ移り、Cookie を写して戻る受け口（passkey.rs）
            passkey::setup(app.handle(), config::load_default().ok().as_ref());
            app.manage(AppState {
                conns: Connections::default(),
                askpass,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_ssh_hosts,
            ui_language,
            mascot::mascot_load,
            mascot::mascot_reload,
            mascot::mascot_commit,
            mascot::mascot_list,
            mascot::mascot_select,
            config_gui,
            connect,
            send,
            disconnect,
            askpass_reply,
            install_plan,
            install_remote,
            install_cancel,
            menu::window_close,
            open_url::open_url_external,
            open_url::browser_resolve_url,
            browser::browser_open,
            browser::browser_bounds,
            browser::browser_visible,
            browser::browser_overlay_enable,
            browser::browser_layer,
            browser::browser_focus,
            browser::browser_go,
            browser::browser_nav,
            browser::browser_close,
            browser::browser_tabs_load,
            browser::browser_tabs_save,
            browser::browser_zoom,
            browser::browser_find,
            browser::browser_devtools,
            browser::browser_passkey_login,
            bookmarks::browser_bookmarks_load,
            bookmarks::browser_bookmarks_save,
            bookmarks::browser_chrome_bookmarks_load,
            download::download_open,
            download::download_reveal,
            export::export_save_text,
            clipboard_history::clipboard_history_list,
            clipboard_popup::clipboard_popup_copy,
            clipboard_popup::clipboard_popup_dismiss,
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
            update::update_check_now,
            update::update_install
        ])
        .build(context())
        .expect("failed to build kisui-terminal")
        .run(|app, event| {
            // メイン窓が閉じたら、隠れている履歴の窓も閉じる（残るとアプリが終わらない）
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } = &event
            {
                if label == "main" {
                    clipboard_popup::close(app);
                }
            }
            if let RunEvent::Exit = event {
                if let Some(s) = app.try_state::<AppState>() {
                    s.conns.close_all();
                    if let Some(b) = app.try_state::<open_url::Forwards>() {
                        b.close_all();
                    }
                    s.askpass.cleanup();
                }
            }
        });
}
