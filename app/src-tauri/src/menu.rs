//! macOS のメニューバー。Tauri の既定のメニューと同じ並びで、「閉じる」（Cmd+W）だけを差し替える（#111）。
//!
//! PDF の欄は iframe で、欄の中を押すとキーが PDF の表示に取られ、親の画面の `keydown` に届かない。
//! そのまま Cmd+W を押すと、既定メニューの「閉じる」が動いて、アプリの窓が閉じてしまう。
//! 差し替えた「閉じる」は窓を閉じず、画面（`close-request` のイベント）に任せる。
//! 今の欄を閉じるか、窓を閉じるかは画面が決める（`app/src/guiKeys.ts` の `closeTarget`）。

use tauri::{AppHandle, Emitter, Manager, Runtime};

/// 差し替えた「閉じる」のメニューの id。
pub const CLOSE_ID: &str = "kisui-close";
/// 画面へ送るイベント名（`app/src/App.tsx` が受ける）。
pub const CLOSE_EVENT: &str = "close-request";

/// 既定のメニューの「閉じる」を差し替えたメニューを付ける（macOS だけ）。
#[cfg(target_os = "macos")]
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    use tauri::menu::{
        AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    };

    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        ..Default::default()
    };
    let close = MenuItem::with_id(app, CLOSE_ID, "Close Window", true, Some("CmdOrCtrl+W"))?;
    let menu = Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "File", true, &[&close])?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &Submenu::with_id_and_items(
                app,
                WINDOW_SUBMENU_ID,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                ],
            )?,
            &Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?,
        ],
    )?;
    app.set_menu(menu)?;
    Ok(())
}

/// 差し替えた「閉じる」が選ばれたとき。メイン窓には画面へ任せ、ほかの窓（クリップボードの履歴の窓）は、今までどおりその窓を閉じる。
pub fn on_close<R: Runtime>(app: &AppHandle<R>) {
    let focused = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false));
    match focused {
        Some(w) if w.label() != "main" => {
            let _ = w.close();
        }
        _ => {
            let _ = app.emit_to("main", CLOSE_EVENT, ());
        }
    }
}

/// 窓を閉じる（画面が、欄ではなく窓を閉じると決めたとき）。
#[tauri::command]
pub fn window_close(window: tauri::WebviewWindow) {
    let _ = window.close();
}
