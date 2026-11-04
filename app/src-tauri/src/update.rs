//! 自動更新（C8）。GitHub Releases の `latest.json`（nightly 版は pre-release `nightly` の）を見て、
//! 新しい版があれば画面に知らせ、ユーザーが押したら取って入れ替え、起動し直す。
//!
//! 自動更新は feature `updater` を付けて作った版（リリースの workflow が作る AppImage と `.dmg`）だけが持つ。
//! Nix で作る版は付けないので、ここのコマンドは「更新は無い」と答える（更新は `nix flake update` で行う）。
//! 取り先と署名の公開鍵は `tauri.conf.json`（nightly 版は `tauri.nightly.conf.json` で上書き）の `plugins.updater`。

use serde::Serialize;
use tauri::State;

/// 画面に見せる新しい版。
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub version: String,
    pub notes: Option<String>,
}

/// 見つけた更新（入れるまで持っておく）。
#[derive(Default)]
pub struct Updates {
    #[cfg(feature = "updater")]
    pending: std::sync::Mutex<Option<tauri_plugin_updater::Update>>,
}

/// 新しい版があるかを調べる。無い・自動更新を持たない版・調べられなかったときは `None`
/// （調べられなかったことは画面に出さない。ネットにつながっていないだけのことが多いため）。
#[tauri::command]
pub async fn update_check(
    app: tauri::AppHandle,
    state: State<'_, Updates>,
) -> Result<Option<UpdateInfo>, String> {
    imp::check(&app, &state).await
}

/// 調べた新しい版を取って入れ替え、起動し直す。戻るのは失敗したときだけ。
#[tauri::command]
pub async fn update_install(
    app: tauri::AppHandle,
    state: State<'_, Updates>,
) -> Result<(), String> {
    imp::install(&app, &state).await
}

#[cfg(feature = "updater")]
mod imp {
    use super::{UpdateInfo, Updates};
    use tauri_plugin_updater::UpdaterExt;

    /// 自動で入れ替えられる形で動いているか。Linux は AppImage のときだけ（ほかの形は入れ替える先が無い）。
    #[cfg(target_os = "linux")]
    fn replaceable(app: &tauri::AppHandle) -> bool {
        use tauri::Manager;
        app.env().appimage.is_some()
    }

    #[cfg(not(target_os = "linux"))]
    fn replaceable(_: &tauri::AppHandle) -> bool {
        true
    }

    pub async fn check(
        app: &tauri::AppHandle,
        state: &Updates,
    ) -> Result<Option<UpdateInfo>, String> {
        if !replaceable(app) {
            return Ok(None);
        }
        let update = match app.updater().map_err(|e| e.to_string())?.check().await {
            Ok(u) => u,
            Err(e) => {
                eprintln!("shijimi-editor: update check failed: {e}");
                return Ok(None);
            }
        };
        let info = update.as_ref().map(|u| UpdateInfo {
            current: u.current_version.clone(),
            version: u.version.clone(),
            notes: u.body.clone(),
        });
        *state.pending.lock().map_err(|e| e.to_string())? = update;
        Ok(info)
    }

    pub async fn install(app: &tauri::AppHandle, state: &Updates) -> Result<(), String> {
        let update = state
            .pending
            .lock()
            .map_err(|e| e.to_string())?
            .take()
            .ok_or("no update to install")?;
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        app.restart()
    }
}

#[cfg(not(feature = "updater"))]
mod imp {
    use super::{UpdateInfo, Updates};

    pub async fn check(_: &tauri::AppHandle, _: &Updates) -> Result<Option<UpdateInfo>, String> {
        Ok(None)
    }

    pub async fn install(_: &tauri::AppHandle, _: &Updates) -> Result<(), String> {
        Err("this build has no auto update (update it with nix flake update)".into())
    }
}
