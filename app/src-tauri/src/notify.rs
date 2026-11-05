//! OS の通知（ターミナルの kitty OSC 99）。
//!
//! 公式の通知プラグインはデスクトップで押された・閉じられたを返さないので、`notify-rust` を直接使う。
//! 通知を出したら専用のスレッドで利用者の操作を待ち、結果を `notify-response` のイベントで画面に返す。
//! 押されたときは窓も前に出す（欄を前に出すのは画面側）。
//!
//! OS ごとの違い（調べた結果。macOS と Windows は実機で確かめていない）:
//! - Linux: 押されたは、通知サーバーが `default` アクションに対応するときだけ来る。閉じられたはどのサーバーでも来る。
//! - Windows: 押されたも閉じられたも来る。インストール済みのアプリ（AppUserModelID あり）でないと押されたが戻らないことがある。
//! - macOS: NSUserNotification（Apple は非推奨）。押されたは来るが、閉じられたは取れない（期限切れと区別できない）。

use notify_rust::{Notification, NotificationResponse};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// 利用者の操作。画面には `activated` / `closed` で渡る。
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    /// 押された
    Activated,
    /// 閉じられた
    Closed,
}

#[derive(Clone, Serialize)]
struct Response {
    /// 画面が通知を出すときに付けた番号
    key: u64,
    kind: Kind,
}

/// 通知を出し、押された・閉じられたを待って `notify-response` で返す。
/// `key` は画面が欄との対応を引くための番号。`focus` が真のときだけ、押されたら窓を前に出す（kitty の `a=focus`）。
/// 出せなかったときはエラー。ただし macOS は通知を出すのが待つ側（`wait_for_response`）なので、出せなかったことはログに出るだけでエラーにならない。
#[tauri::command]
pub fn notify_show(
    app: AppHandle,
    key: u64,
    title: String,
    body: Option<String>,
    focus: bool,
) -> Result<(), String> {
    let mut n = Notification::new();
    n.summary(&title);
    if let Some(body) = &body {
        n.body(body);
    }
    n.auto_icon();
    // Linux の通知サーバーに、押されたときの既定の動きを持たせる（これが無いと押されたが来ない）
    #[cfg(all(unix, not(target_os = "macos")))]
    n.action("default", "default");
    // 入れたアプリのときだけ AppUserModelID を付ける（開発中は付けない）
    #[cfg(windows)]
    if !tauri::is_dev() {
        n.app_id(&app.config().identifier);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = notify_rust::set_application(if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            &app.config().identifier
        });
    }
    let handle = n.show().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let mut kind = None;
        if let Err(e) = handle.wait_for_response(|r: &NotificationResponse| {
            kind = match r {
                NotificationResponse::Default | NotificationResponse::Action(_) => {
                    Some(Kind::Activated)
                }
                NotificationResponse::Reply(_) => None,
                NotificationResponse::Closed(_) => Some(Kind::Closed),
            };
        }) {
            eprintln!("notify: {e}");
        }
        let Some(kind) = kind else { return };
        if focus && matches!(kind, Kind::Activated) {
            front(&app);
        }
        let _ = app.emit("notify-response", Response { key, kind });
    });
    Ok(())
}

/// 窓を前に出す（最小化を戻し、フォーカスを移す）。
fn front(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}
