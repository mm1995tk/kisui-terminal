//! DB のタブの結果の書き出し（#349）：保存のダイアログで場所を選んでもらい、そこに文字を書く。
//!
//! 窓（webview）にはファイルを書く権限を渡さない。画面が頼めるのは「この名前で、この文字を保存したい」だけで、
//! 書く場所は、ユーザーがダイアログで選んだものに限る（画面はパスを渡せない）。

use std::fs;
use std::path::Path;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// 保存の既定のファイル名として使えない字（パスの区切りと、多くの OS でファイル名に使えない字・制御文字）を `_` にする。
/// 空になったら `export` にする。
pub fn clean_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() {
        "export".to_string()
    } else {
        s
    }
}

/// 保存のダイアログを出して、選んだ場所に `text` を書く。やめたら `None`、書けたらそのパス。
/// `extension` は拡張子（`csv` など。ダイアログの絞り込みにだけ使う）。選ばれたパスには、拡張子を足さず、そのまま書く
/// （足した名前は、ダイアログが上書きを確かめた相手ではないため）。
#[tauri::command]
pub async fn export_save_text(
    app: AppHandle,
    default_name: String,
    extension: String,
    text: String,
) -> Result<Option<String>, String> {
    let ext = extension.trim_start_matches('.').to_string();
    let mut dialog = app
        .dialog()
        .file()
        .set_file_name(clean_name(&default_name))
        .add_filter(ext.to_uppercase(), &[ext.as_str()]);
    if let Some(w) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&w);
    }
    let Some(picked) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("could not use the chosen location: {e}"))?;
    write_text(&path, &text)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// `text` を `path` に書く（あれば上書き。保存のダイアログが上書きを確かめている）。
fn write_text(path: &Path, text: &str) -> Result<(), String> {
    fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_name_replaces_separators_and_controls() {
        assert_eq!(clean_name("shop/orders.csv"), "shop_orders.csv");
        assert_eq!(clean_name("a\\b:c*d?e\"f<g>h|i"), "a_b_c_d_e_f_g_h_i");
        assert_eq!(clean_name("a\nb"), "a_b");
    }

    #[test]
    fn clean_name_never_empty_or_hidden_dots() {
        assert_eq!(clean_name(""), "export");
        assert_eq!(clean_name("  "), "export");
        assert_eq!(clean_name("..."), "export");
        assert_eq!(clean_name("..hidden"), "hidden");
        assert_eq!(clean_name("日本語.csv"), "日本語.csv");
    }

    #[test]
    fn write_text_writes_and_overwrites() {
        let dir = std::env::temp_dir().join(format!("kisui-export-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.csv");
        write_text(&p, "x\n").unwrap();
        write_text(&p, "y\n").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "y\n");
        assert!(write_text(&dir.join("no/such/dir.csv"), "z").is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
