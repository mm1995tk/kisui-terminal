//! 内蔵ブラウザ（macOS）を、中継型（relay）のプロキシ masque-proxy に通す（#294）。設計書 docs/design/browser-and-proxy.md の
//! 「内蔵ブラウザのプロキシ（macOS。#294）」。
//!
//! macOS の名前解決は、IPv6 の無い回線で Cloudflare WARP を使うと IPv6 のアドレスを返さず、Google に IPv4 の出口でつながって
//! `www.google.com.hk` に移される（#287）。masque-proxy は行き先の名前を自分で DNS に問い合わせ、IPv6 に先につなぐ。
//! HTTP/3 を運べる中継型なので、全部のサイトを通しても HTTP/3 が残る（#290）。
//!
//! - プロキシは、この殻のプロセスの tokio のランタイム（tauri の非同期のランタイム）で動かす。待ち受けは 127.0.0.1 だけで、
//!   ポートは起動のたびに空いているものを取る。
//! - WKWebView には、データストアの `proxyConfigurations`（macOS 14 から）に、Network.framework の中継の設定
//!   （`nw_proxy_config_create_relay`）を入れる。共有のデータストア（`defaultDataStore`）には 1 度、シークレットのタブには
//!   タブごとに作るデータストアに入れる（`private_configuration`）。ページが開いた新しい窓のタブは、開いた元のタブと同じ
//!   データストアを使うので、元と同じになる。
//! - WKWebView は、中継のプロキシの TLS で、OS に信頼された証明書しか通さない（#290）。そこで Mac ごとに鍵と証明書を作り、
//!   ログインのキーチェーンで、用途を SSL、名前を `localhost` に限って信頼させる（macOS がパスワードを聞く）。
//!   証明書は `localhost`・`127.0.0.1`・`::1` 用で、CA ではなく、用途は TLS のサーバーだけ。
//!   鍵はファイルに置かず、ログインのキーチェーンの項目（generic password）に置く。
//! - 用意するのは、内蔵ブラウザで初めてタブを開くとき（`ready`）。断られた・信頼させられなかった・macOS 13 以前なら、
//!   プロキシを使わず、今までどおり開く。断られたことはデータのフォルダの `browser-proxy-declined` に覚え、もう聞かない
//!   （消すと次の起動で聞き直す）。
//! - 信頼を外すのは、README の `security` のコマンド（アプリに操作は無い）。

use std::ffi::{c_char, c_void, CString};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use masque_proxy::{Config, Identity, Proxy};
use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol};
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_foundation::NSArray;
use objc2_web_kit::{WKWebViewConfiguration, WKWebsiteDataStore};
use security_framework::certificate::SecCertificate;
use security_framework::os::macos::keychain::SecKeychain;
use security_framework::os::macos::passwords::find_generic_password;
use security_framework::policy::SecPolicy;
use security_framework::secure_transport::SslProtocolSide;
use security_framework::trust::SecTrust;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

/// キーチェーンの項目（鍵と証明書）の service と account。README の消すコマンドもこの名前を使う。
const KEYCHAIN_SERVICE: &str = "kisui-terminal browser proxy";
const KEYCHAIN_ACCOUNT: &str = "identity";
/// 証明書の名前（CN）。README の消すコマンド（`security delete-certificate -c`）もこの名前で探す。
const COMMON_NAME: &str = "kisui-terminal browser proxy (localhost)";
/// 証明書の有効な長さ。macOS は、TLS のサーバーの証明書で 825 日を超えるものを信頼しない。
const VALIDITY: Duration = Duration::from_secs(365 * 24 * 60 * 60);
/// 切れるまでがこれより短くなったら、作り直す（作り直すと、もう 1 度信頼を聞く）。
const RENEW_BEFORE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// 信頼させる名前。中継の行き先（`nw_endpoint_create_host`）もこの名前にする（TLS で確かめる名前になる）。
const RELAY_HOST: &str = "localhost";
/// 断られたことを覚えるファイル（データのフォルダの中）。
const DECLINED_FILE: &str = "browser-proxy-declined";
/// プロキシに通さない行き先。中継（`kisui relay`）が開く `http://127.0.0.1:<ポート>/` のタブと、開発の画面など。
/// 通してもプロキシは 127.0.0.1 にもつなぐが、手元の行き先に回り道をさせない。
const EXCLUDED_DOMAINS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

/// キーチェーンに置く項目の形式の頭（版を含む）。
const MAGIC: &[u8; 8] = b"KSPROXY1";

const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
const ERR_SEC_DUPLICATE_ITEM: i32 = -25299;
const ERR_SEC_USER_CANCELED: i32 = -128;
const ERR_AUTHORIZATION_CANCELED: i32 = -60006;
/// SecTrustSettings の結果：この証明書を根として信頼する（自己署名の証明書。`security add-trusted-cert -r trustRoot`）
const TRUST_SETTINGS_RESULT_TRUST_ROOT: i32 = 1;
/// SecTrustSettings の利用者の領域
const TRUST_SETTINGS_DOMAIN_USER: u32 = 0;

/// 動いているプロキシの待ち受けのポート（どちらも 127.0.0.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ports {
    h3: u16,
    h2: u16,
}

struct Relay {
    ports: Ports,
    /// 落とすと待ち受けを止める（アプリが終わるまで持つ）
    _proxy: Proxy,
}

/// 用意した結果（None ならプロキシを使わない）。初めてのタブで 1 度だけ決める。
static RELAY: tokio::sync::OnceCell<Option<Relay>> = tokio::sync::OnceCell::const_new();

/// プロキシを用意する（初めて呼ばれたときだけ。証明書を信頼させていなければ、ここで macOS が聞く）。
/// 使えるなら、共有のデータストアにはもう当ててあり、待ち受けのポートを返す。使えないなら None（プロキシ無しで開く）。
/// 同時に呼ばれても、聞くのは 1 度で、ほかは答えを待つ。
pub async fn ready(app: &AppHandle) -> Option<Ports> {
    RELAY
        .get_or_init(|| start(app.clone()))
        .await
        .as_ref()
        .map(|r| r.ports)
}

async fn start(app: AppHandle) -> Option<Relay> {
    // macOS 13 以前（中継の設定もデータストアの proxyConfigurations も無い）は、聞かずにプロキシ無しで動く
    relay_fns()?;
    let dir = app.path().app_data_dir().ok();
    let identity = tauri::async_runtime::spawn_blocking(move || prepare_identity(dir.as_deref()))
        .await
        .ok()
        .flatten()?;
    let proxy = match Proxy::start(Config {
        identity: Some(identity),
        ..Config::default()
    })
    .await
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!("kisui-terminal: cannot start the browser proxy: {e}");
            return None;
        }
    };
    let ports = Ports {
        h3: proxy.h3_addr().port(),
        h2: proxy.h2_addr().port(),
    };
    // 共有のデータストア（すべてのふつうのタブ）に当てる
    let applied = on_main(&app, move |mtm| {
        // SAFETY: メインスレッドで呼ぶ（mtm）
        let store = unsafe { WKWebsiteDataStore::defaultDataStore(mtm) };
        apply(&store, ports)
    })
    .await
    .unwrap_or(false);
    if !applied {
        eprintln!("kisui-terminal: cannot set the browser proxy on the WebView");
        return None;
    }
    Some(Relay {
        ports,
        _proxy: proxy,
    })
}

/// シークレットのタブに使う WebView の設定（タブごとの、ディスクに残さないデータストアにプロキシを当てたもの）。
/// メインスレッドで作り、タブの webview を作るとき（`with_webview_configuration`）に渡す。
pub struct PrivateConfiguration(pub Retained<WKWebViewConfiguration>);

// SAFETY: 作ったメインスレッドの外では、持って運ぶだけで、メッセージを送らない（tauri の WebviewAttributes も、同じく
// WKWebViewConfiguration を持ってメインスレッドへ運ぶ）。
unsafe impl Send for PrivateConfiguration {}

/// シークレットのタブの WebView の設定を作る。
pub async fn private_configuration(app: &AppHandle, ports: Ports) -> Option<PrivateConfiguration> {
    on_main(app, move |mtm| {
        // SAFETY: メインスレッドで呼ぶ（mtm）
        unsafe {
            let store = WKWebsiteDataStore::nonPersistentDataStore(mtm);
            if !apply(&store, ports) {
                return None;
            }
            let config = WKWebViewConfiguration::new(mtm);
            config.setWebsiteDataStore(&store);
            Some(PrivateConfiguration(config))
        }
    })
    .await
    .flatten()
}

/// メインスレッドで f を動かし、答えを待つ。
async fn on_main<R: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(MainThreadMarker) -> R + Send + 'static,
) -> Option<R> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        if let Some(mtm) = MainThreadMarker::new() {
            let _ = tx.send(f(mtm));
        }
    })
    .ok()?;
    rx.await.ok()
}

// ---- 鍵と証明書 ----

/// キーチェーンに置くもの。
struct Stored {
    /// 証明書が切れる時刻（UNIX 時刻の秒）
    not_after: u64,
    identity: Identity,
}

/// キーチェーンに置く形にする：MAGIC・切れる時刻（8 バイト）・証明書の長さ（4 バイト）・証明書・鍵。
fn encode(s: &Stored) -> Vec<u8> {
    let cert = s.identity.certificate_der();
    let key = s.identity.key_der();
    let mut out = Vec::with_capacity(MAGIC.len() + 12 + cert.len() + key.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&s.not_after.to_be_bytes());
    out.extend_from_slice(&(cert.len() as u32).to_be_bytes());
    out.extend_from_slice(cert);
    out.extend_from_slice(key);
    out
}

fn decode(b: &[u8]) -> Option<Stored> {
    let rest = b.strip_prefix(MAGIC.as_slice())?;
    let (not_after, rest) = rest.split_first_chunk::<8>()?;
    let (len, rest) = rest.split_first_chunk::<4>()?;
    let len = u32::from_be_bytes(*len) as usize;
    if len == 0 || rest.len() <= len {
        return None;
    }
    let (cert, key) = rest.split_at(len);
    Some(Stored {
        not_after: u64::from_be_bytes(*not_after),
        identity: Identity::from_der(cert.to_vec(), key.to_vec()),
    })
}

/// 作り直す時か（切れるまでが RENEW_BEFORE より短い）。
fn needs_renewal(not_after: u64, now: u64) -> bool {
    not_after.saturating_sub(now) < RENEW_BEFORE.as_secs()
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn generate(now: u64) -> Option<Stored> {
    match Identity::generate(COMMON_NAME, VALIDITY) {
        Ok(identity) => Some(Stored {
            not_after: now + VALIDITY.as_secs(),
            identity,
        }),
        Err(e) => {
            eprintln!("kisui-terminal: cannot make a certificate for the browser proxy: {e}");
            None
        }
    }
}

/// キーチェーンから読む。無ければ None、読めなければ（利用者が断ったなど）Err。
fn load(kc: &SecKeychain) -> Result<Option<Stored>, String> {
    match find_generic_password(Some(&[kc.clone()]), KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        // 形の合わないもの（壊れた・前の形式）は、無いものとして作り直す
        Ok((password, _)) => Ok(decode(&password)),
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn save(kc: &SecKeychain, s: &Stored) -> Result<(), String> {
    kc.set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, &encode(s))
        .map_err(|e| e.to_string())
}

/// 使う身元（鍵と証明書）を決める。キーチェーンから読み、無ければ作り、信頼されていなければ信頼を聞く。
/// 使えなければ None。メインスレッドの外で呼ぶ（macOS の確認の答えを待つ）。
fn prepare_identity(data_dir: Option<&Path>) -> Option<Identity> {
    let declined = data_dir.map(|d| d.join(DECLINED_FILE));
    if declined.as_deref().is_some_and(Path::exists) {
        return None;
    }
    let kc = match SecKeychain::default() {
        Ok(kc) => kc,
        Err(e) => {
            eprintln!("kisui-terminal: cannot open the keychain for the browser proxy: {e}");
            return None;
        }
    };
    let stored = match load(&kc) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("kisui-terminal: cannot read the browser proxy key from the keychain: {e}");
            return None;
        }
    };
    let now = unix_now();
    let current = match stored {
        Some(s) if !needs_renewal(s.not_after, now) => s,
        // 切れそうなもの（または切れたもの）は作り直す。新しい方を信頼させられなければ、まだ切れていない古い方を使う
        Some(old) => return renew(&kc, old, now, declined.as_deref()),
        None => {
            let s = generate(now)?;
            // 信頼を断られても、次に聞くときは同じ証明書を使う（キーチェーンに証明書を重ねて入れない）
            if let Err(e) = save(&kc, &s) {
                eprintln!("kisui-terminal: cannot keep the browser proxy key in the keychain: {e}");
                return None;
            }
            s
        }
    };
    let cert = SecCertificate::from_der(current.identity.certificate_der()).ok()?;
    if is_trusted(&cert) || ask_trust(&cert, declined.as_deref()) {
        Some(current.identity)
    } else {
        None
    }
}

/// 切れそうな身元を作り直す。新しい方を信頼させられたら、キーチェーンの項目を差し替え、古い証明書と信頼を消す。
fn renew(kc: &SecKeychain, old: Stored, now: u64, declined: Option<&Path>) -> Option<Identity> {
    let old_cert = SecCertificate::from_der(old.identity.certificate_der()).ok();
    let old_usable = old.not_after > now && old_cert.as_ref().is_some_and(is_trusted);
    let Some(new) = generate(now) else {
        return old_usable.then_some(old.identity);
    };
    let new_cert = SecCertificate::from_der(new.identity.certificate_der()).ok()?;
    if !ask_trust(&new_cert, declined) {
        // 新しい証明書はキーチェーンに入れたので消す（覚えないので、残すと同じ名前の証明書が重なる）
        forget(new.identity.certificate_der());
        return old_usable.then_some(old.identity);
    }
    if let Err(e) = save(kc, &new) {
        // 次の起動では古い方を読むが、それが切れていれば、また作り直して聞く
        eprintln!("kisui-terminal: cannot keep the browser proxy key in the keychain: {e}");
    } else {
        forget(old.identity.certificate_der());
    }
    Some(new.identity)
}

/// 証明書が、名前 `localhost` の TLS のサーバーとして、この Mac に信頼されているか。
fn is_trusted(cert: &SecCertificate) -> bool {
    let policy = SecPolicy::create_ssl(SslProtocolSide::SERVER, Some(RELAY_HOST));
    let Ok(mut trust) = SecTrust::create_with_certificates(&[cert.clone()], &[policy]) else {
        return false;
    };
    let _ = trust.set_network_fetch_allowed(false);
    trust.evaluate_with_error().is_ok()
}

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecTrustSettingsSetTrustSettings(
        cert: *const c_void,
        domain: u32,
        trust_settings: *const c_void,
    ) -> i32;
}

/// 証明書をログインのキーチェーンに入れ、用途を SSL、名前を `localhost` に限って信頼させる
/// （`security add-trusted-cert -r trustRoot -p ssl -s localhost` と同じ）。macOS がパスワードを聞く。
/// 信頼させられたら true。断られたら、覚えて次から聞かない。
fn ask_trust(cert: &SecCertificate, declined: Option<&Path>) -> bool {
    if let Err(e) = cert.add_to_keychain(None) {
        if e.code() != ERR_SEC_DUPLICATE_ITEM {
            eprintln!(
                "kisui-terminal: cannot add the browser proxy certificate to the keychain: {e}"
            );
            return false;
        }
    }
    let settings = CFArray::from_CFTypes(&[trust_settings()]);
    // SAFETY: どちらも生きている CF のオブジェクト。SecTrustSettingsSetTrustSettings は引数を取り込まない（retain する）
    let status = unsafe {
        SecTrustSettingsSetTrustSettings(
            cert.as_concrete_TypeRef().cast(),
            TRUST_SETTINGS_DOMAIN_USER,
            settings.as_CFTypeRef(),
        )
    };
    match status {
        0 => {}
        ERR_AUTHORIZATION_CANCELED | ERR_SEC_USER_CANCELED => {
            eprintln!("kisui-terminal: the browser proxy certificate was not trusted; the built-in browser goes without the proxy");
            if let Some(p) = declined {
                if let Err(e) = remember_declined(p) {
                    eprintln!("kisui-terminal: cannot write {}: {e}", p.display());
                }
            }
            return false;
        }
        s => {
            eprintln!("kisui-terminal: cannot trust the browser proxy certificate (OSStatus {s})");
            return false;
        }
    }
    // 信頼の設定が評価に効くまで、少し待つことがある
    for _ in 0..10 {
        if is_trusted(cert) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    eprintln!("kisui-terminal: the browser proxy certificate is still not trusted after setting its trust");
    false
}

/// 信頼の設定 1 つ：用途 SSL、名前 `localhost`、根として信頼。
fn trust_settings() -> CFDictionary<CFType, CFType> {
    let policy = SecPolicy::create_ssl(SslProtocolSide::SERVER, None);
    CFDictionary::from_CFType_pairs(&[
        (
            CFString::from_static_string("kSecTrustSettingsPolicy").as_CFType(),
            policy.as_CFType(),
        ),
        (
            CFString::from_static_string("kSecTrustSettingsPolicyString").as_CFType(),
            CFString::from_static_string(RELAY_HOST).as_CFType(),
        ),
        (
            CFString::from_static_string("kSecTrustSettingsResult").as_CFType(),
            CFNumber::from(TRUST_SETTINGS_RESULT_TRUST_ROOT).as_CFType(),
        ),
    ])
}

fn remember_declined(p: &Path) -> std::io::Result<()> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(p, b"")
}

/// 使わなくなった証明書を、キーチェーンと信頼の設定から消す（`security delete-certificate -t`。信頼の設定があれば、
/// macOS がパスワードを聞く）。消せなくても続ける（切れた・信頼されていない証明書は使われない）。
fn forget(cert_der: &[u8]) {
    let hash: String = Sha256::digest(cert_der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect();
    match std::process::Command::new("/usr/bin/security")
        .args(["delete-certificate", "-t", "-Z", &hash])
        .stdout(std::process::Stdio::null())
        .status()
    {
        Ok(s) if s.success() => {}
        Ok(s) => eprintln!("kisui-terminal: cannot remove the old browser proxy certificate ({s})"),
        Err(e) => eprintln!("kisui-terminal: cannot remove the old browser proxy certificate: {e}"),
    }
}

// ---- Network.framework の中継の設定 ----

type NwObject = *mut NSObject;

#[link(name = "Network", kind = "framework")]
extern "C" {
    fn nw_endpoint_create_host(hostname: *const c_char, port: *const c_char) -> NwObject;
    fn nw_tls_create_options() -> NwObject;
}

/// macOS 14 から入った関数。古い macOS でも起動できるよう、リンクせずに探す。
struct RelayFns {
    relay_hop_create: unsafe extern "C" fn(NwObject, NwObject, NwObject) -> NwObject,
    proxy_config_create_relay: unsafe extern "C" fn(NwObject, NwObject) -> NwObject,
    proxy_config_set_failover_allowed: unsafe extern "C" fn(NwObject, bool),
    proxy_config_add_excluded_domain: unsafe extern "C" fn(NwObject, *const c_char),
}

fn relay_fns() -> Option<&'static RelayFns> {
    static FNS: OnceLock<Option<RelayFns>> = OnceLock::new();
    FNS.get_or_init(|| {
        // Network.framework はリンクしているので（nw_endpoint_create_host）、読み込まれている
        let find = |name: &std::ffi::CStr| {
            // SAFETY: 名前は NUL で終わる。見つからなければ null
            let p = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
            (!p.is_null()).then_some(p)
        };
        // SAFETY: 探した関数は、Network.framework の宣言（nw_relay_hop_create など）と同じ型
        unsafe {
            Some(RelayFns {
                relay_hop_create: std::mem::transmute::<*mut c_void, _>(find(
                    c"nw_relay_hop_create",
                )?),
                proxy_config_create_relay: std::mem::transmute::<*mut c_void, _>(find(
                    c"nw_proxy_config_create_relay",
                )?),
                proxy_config_set_failover_allowed: std::mem::transmute::<*mut c_void, _>(find(
                    c"nw_proxy_config_set_failover_allowed",
                )?),
                proxy_config_add_excluded_domain: std::mem::transmute::<*mut c_void, _>(find(
                    c"nw_proxy_config_add_excluded_domain",
                )?),
            })
        }
    })
    .as_ref()
}

/// Network.framework が返したもの（retain 済み）を受け取る。落とすと release する。
/// Network.framework のオブジェクトは、Objective-C のオブジェクト（OS_object）。
fn owned(p: NwObject) -> Option<Retained<NSObject>> {
    // SAFETY: p は Network.framework が作って返した（+1 の）オブジェクトか null
    unsafe { Retained::from_raw(p) }
}

/// 中継の設定：`localhost` の HTTP/3（UDP）と HTTP/2（TCP）の口を 1 つの hop にする。
/// プロキシにつながらなければ、プロキシ無しでつなぐ（failover）。手元の行き先はプロキシに通さない。
fn relay_config(ports: Ports) -> Option<Retained<NSObject>> {
    let f = relay_fns()?;
    let host = CString::new(RELAY_HOST).ok()?;
    let h3_port = CString::new(ports.h3.to_string()).ok()?;
    let h2_port = CString::new(ports.h2.to_string()).ok()?;
    // SAFETY: 引数はどれも生きている（hop と設定は、受け取ったものを自分で retain する）
    unsafe {
        let h3 = owned(nw_endpoint_create_host(host.as_ptr(), h3_port.as_ptr()))?;
        let h2 = owned(nw_endpoint_create_host(host.as_ptr(), h2_port.as_ptr()))?;
        let tls = owned(nw_tls_create_options())?;
        let hop = owned((f.relay_hop_create)(
            Retained::as_ptr(&h3).cast_mut(),
            Retained::as_ptr(&h2).cast_mut(),
            Retained::as_ptr(&tls).cast_mut(),
        ))?;
        let config = owned((f.proxy_config_create_relay)(
            Retained::as_ptr(&hop).cast_mut(),
            std::ptr::null_mut(),
        ))?;
        let p = Retained::as_ptr(&config).cast_mut();
        (f.proxy_config_set_failover_allowed)(p, true);
        for d in EXCLUDED_DOMAINS {
            let d = CString::new(d).ok()?;
            (f.proxy_config_add_excluded_domain)(p, d.as_ptr());
        }
        Some(config)
    }
}

/// データストアに中継の設定を当てる。当てられたら true。メインスレッドで呼ぶ。
fn apply(store: &WKWebsiteDataStore, ports: Ports) -> bool {
    if !store.respondsToSelector(sel!(setProxyConfigurations:)) {
        return false;
    }
    let Some(config) = relay_config(ports) else {
        return false;
    };
    let configs = NSArray::from_retained_slice(&[config]);
    // SAFETY: proxyConfigurations は NSArray<nw_proxy_config_t>（macOS 14 から。上で確かめた）
    let _: () = unsafe { msg_send![store, setProxyConfigurations: &*configs] };
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_identity_round_trips() {
        let identity = Identity::generate(COMMON_NAME, VALIDITY).unwrap();
        let s = Stored {
            not_after: 1_900_000_000,
            identity: identity.clone(),
        };
        let back = decode(&encode(&s)).unwrap();
        assert_eq!(back.not_after, 1_900_000_000);
        assert_eq!(back.identity.certificate_der(), identity.certificate_der());
        assert_eq!(back.identity.key_der(), identity.key_der());
    }

    #[test]
    fn broken_items_are_not_read() {
        assert!(decode(b"").is_none());
        assert!(decode(b"KSPROXY0aaaaaaaabbbbcc").is_none());
        let mut b = MAGIC.to_vec();
        b.extend_from_slice(&0u64.to_be_bytes());
        b.extend_from_slice(&10u32.to_be_bytes());
        b.extend_from_slice(b"short");
        assert!(decode(&b).is_none());
    }

    #[test]
    fn renews_a_month_before_it_runs_out() {
        let now = 1_800_000_000;
        let day = 24 * 60 * 60;
        assert!(!needs_renewal(now + 31 * day, now));
        assert!(needs_renewal(now + 29 * day, now));
        assert!(needs_renewal(now - day, now));
        // 作ったばかりの証明書は作り直さない
        assert!(!needs_renewal(now + VALIDITY.as_secs(), now));
    }

    #[test]
    fn the_certificate_is_a_localhost_server_certificate() {
        let identity = Identity::generate(COMMON_NAME, VALIDITY).unwrap();
        let cert = SecCertificate::from_der(identity.certificate_der()).unwrap();
        assert_eq!(cert.subject_summary(), COMMON_NAME);
        // 信頼の設定が無い（テストの機械では信頼させない）ので、信頼されていない
        assert!(!is_trusted(&cert));
    }

    #[test]
    fn trust_is_limited_to_ssl_and_localhost() {
        let d = trust_settings();
        let get = |k: &'static str| {
            d.find(&CFString::from_static_string(k).as_CFType())
                .map(|v| v.clone())
        };
        let s = get("kSecTrustSettingsPolicyString").unwrap();
        assert_eq!(s.downcast::<CFString>().unwrap().to_string(), "localhost");
        let r = get("kSecTrustSettingsResult").unwrap();
        assert_eq!(
            r.downcast::<CFNumber>().unwrap().to_i32(),
            Some(TRUST_SETTINGS_RESULT_TRUST_ROOT)
        );
        assert!(get("kSecTrustSettingsPolicy").is_some());
    }

    #[test]
    fn relay_config_is_made_on_macos_14_or_later() {
        // このテストを動かす macOS が 14 以上なら、中継の設定を作れる
        if relay_fns().is_some() {
            assert!(relay_config(Ports {
                h3: 45443,
                h2: 45444
            })
            .is_some());
        }
    }

    /// キーチェーンに書いて読めることを、使い捨てのキーチェーンで確かめる（ログインのキーチェーンは使わない）。
    /// キーチェーンのファイルを作るので、ふだんは動かさない：`cargo test -p kisui-terminal keychain -- --ignored`
    #[test]
    #[ignore]
    fn keychain_round_trip() {
        use security_framework::os::macos::keychain::CreateOptions;
        let dir = std::env::temp_dir().join(format!("kisui-proxy-kc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.keychain-db");
        let kc = CreateOptions::new()
            .password("kisui-terminal-test")
            .create(&path)
            .unwrap();
        let first = load(&kc);
        let s = generate(unix_now()).unwrap();
        save(&kc, &s).unwrap();
        let back = load(&kc).unwrap().unwrap();
        // 差し替えもできる
        let s2 = generate(unix_now()).unwrap();
        save(&kc, &s2).unwrap();
        let back2 = load(&kc).unwrap().unwrap();
        let _ = std::process::Command::new("/usr/bin/security")
            .arg("delete-keychain")
            .arg(&path)
            .status();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(matches!(first, Ok(None)));
        assert_eq!(back.identity.key_der(), s.identity.key_der());
        assert_eq!(back2.identity.key_der(), s2.identity.key_der());
    }
}
