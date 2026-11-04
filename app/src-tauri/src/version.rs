//! GUI の版。Tauri の設定の `version`（リリースの workflow と Nix がビルドのときに入れる。設定に無ければ
//! Cargo.toml の版）を、起動のときに 1 度だけ覚える。リモートに入れる shj の版（install.rs）・置き場
//! （connection.rs）と、自動更新（update.rs）が比べる版を、ここ 1 か所にそろえる。

use std::sync::OnceLock;

static VERSION: OnceLock<String> = OnceLock::new();

/// 起動のときに呼ぶ（`app.package_info().version`）。2 回目からは何もしない。
pub fn init(v: String) {
    let _ = VERSION.set(v);
}

/// GUI の版。init の前（単体テスト）は Cargo.toml の版。
pub fn get() -> &'static str {
    VERSION
        .get()
        .map(String::as_str)
        .unwrap_or(env!("CARGO_PKG_VERSION"))
}
