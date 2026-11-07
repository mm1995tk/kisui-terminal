//! macOS の .app に付ける entitlement が tauri.conf.json から外れないようにする。
//! 要る理由は Entitlements.plist のコメントにある。

use std::path::Path;

const KEY: &str = "com.apple.security.cs.allow-unsigned-executable-memory";

#[test]
fn macos_bundle_allows_unsigned_executable_memory() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let conf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("tauri.conf.json")).unwrap())
            .unwrap();
    let path = conf["bundle"]["macOS"]["entitlements"]
        .as_str()
        .expect("bundle.macOS.entitlements が tauri.conf.json に無い");
    let plist = std::fs::read_to_string(dir.join(path)).unwrap();
    let after_key = plist
        .split_once(&format!("<key>{KEY}</key>"))
        .unwrap_or_else(|| panic!("{path} に {KEY} が無い"))
        .1;
    assert!(
        after_key.trim_start().starts_with("<true/>"),
        "{path} の {KEY} が true でない"
    );
}
