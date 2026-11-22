//! 内蔵ブラウザのタブを、通信を記録するプロキシ（`kisui serve` の proxy.*。#409）に通す。設計書 docs/design/browser-and-proxy.md の
//! 「通信を記録するプロキシ（#409）」。
//!
//! プロキシは、手元のマシンの `kisui serve` が 127.0.0.1 のポートで動かす（Go の proxy パッケージ）。画面が、通すと決めた
//! タブの webview を、そのポートをプロキシにして作り直す（`browser_open` の `proxy`）。
//!
//! - **通すのはそのタブだけ**：プロキシの設定は、OS の WebView ではタブ（webview）ごとではなく、ページのデータ
//!   （Cookie などの置き場。macOS は WKWebsiteDataStore、Linux は WebsiteDataManager）ごとに付く。共有のデータに付けると、
//!   ほかのタブも通ってしまう。そこで、通すタブには、そのタブだけの、ディスクに残さないデータを使う（シークレットのタブと同じ）。
//!   通している間は、共有のログインが見えない（通したタブの中でログインし直す。その通信も記録に出る）。
//!   ページが開いた新しい窓のタブは、開いた元のタブと同じデータを使うので、同じプロキシに通る。
//! - **証明書**：プロキシは HTTPS の間に入り、自前の認証局で作った証明書を返す。認証局は OS に入れないので、
//!   WebView はその証明書を信じない。OS の WebView には、認証局をデータごとに足す口が無い。そこで、通すタブのデータに限って、
//!   WebView には証明書を確かめさせない（Linux は TLS のエラーを無視する設定、macOS は証明書の確認の問い合わせに「使う」と答える）。
//!   このタブの通信は、すべて 127.0.0.1 のプロキシに行き、行き先の証明書はプロキシが OS の認証局で確かめる
//!   （正しくなければ、プロキシが 502 を返す）。確かめる役が、WebView からプロキシに移るだけで、確かめない通信は無い。
//!   ほかのタブ・メインの画面の確かめ方は変えない。
//! - macOS は 14 以降（データごとのプロキシの設定 `proxyConfigurations` が要る）。13 以前では、通せないと答える。
//!   通すタブは、#294 の中継型のプロキシ（browser_proxy.rs）には通らない（プロキシを 2 つ重ねない）。

use tauri::Url;

/// プロキシの待ち受け口（127.0.0.1 の port）の URL。
pub fn proxy_url(port: u16) -> Result<Url, String> {
    if port == 0 {
        return Err("invalid proxy port".into());
    }
    Url::parse(&format!("http://127.0.0.1:{port}")).map_err(|e| e.to_string())
}

/// Linux：このタブだけのデータを使い、proxy（`proxy_url` の URL）のプロキシに通す webview にする。
#[cfg(target_os = "linux")]
pub fn with_proxy(
    builder: tauri::WebviewBuilder<tauri::Wry>,
    proxy: Url,
) -> tauri::WebviewBuilder<tauri::Wry> {
    builder.incognito(true).proxy_url(proxy)
}

/// Linux：作った webview のデータに、TLS のエラーを無視させてから、url を開く。
/// 設定の前に読み込みが始まらないよう、webview は `about:blank` で作っておく（呼ぶ側）。
#[cfg(target_os = "linux")]
pub fn trust_and_load(v: &tauri::Webview, url: Url) -> Result<(), String> {
    v.with_webview(move |pv| {
        use webkit2gtk::{TLSErrorsPolicy, WebViewExt, WebsiteDataManagerExt};
        let w = pv.inner();
        match w.website_data_manager() {
            Some(m) => {
                m.set_tls_errors_policy(TLSErrorsPolicy::Ignore);
                w.load_uri(url.as_str());
            }
            // データが取れなければ、開かない（証明書のエラーのページを出すより、何も出さない方が分かりやすい）
            None => {
                eprintln!("kisui-terminal: cannot set up the proxied tab; the page is not opened")
            }
        }
    })
    .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
pub use mac::{configuration, forget, Configuration};

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::ffi::{c_char, c_void, CString};
    use std::sync::OnceLock;

    use block2::Block;
    use objc2::encode::{Encoding, RefEncode};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Imp, NSObject, NSObjectProtocol, Sel};
    use objc2::{class, msg_send, sel};
    use objc2_foundation::{NSArray, NSString};
    use objc2_web_kit::{WKWebView, WKWebViewConfiguration, WKWebsiteDataStore};
    use tauri::{AppHandle, Manager};

    /// 通すタブに使う WebView の設定（そのタブだけの、ディスクに残さないデータストアにプロキシを当てたもの）。
    pub struct Configuration(pub Retained<WKWebViewConfiguration>);

    // SAFETY: 作ったメインスレッドの外では、持って運ぶだけで、メッセージを送らない（browser_proxy.rs の PrivateConfiguration と同じ）。
    unsafe impl Send for Configuration {}

    thread_local! {
        /// 通しているタブのデータストア（元のタブの id → データストア）。証明書の確認の問い合わせで、通しているタブの
        /// webview かを見分ける。メインスレッドだけが触る。
        static STORES: RefCell<Vec<(String, Retained<WKWebsiteDataStore>)>> = const { RefCell::new(Vec::new()) };
    }

    type NwObject = *mut NSObject;

    #[link(name = "Network", kind = "framework")]
    extern "C" {
        fn nw_endpoint_create_host(hostname: *const c_char, port: *const c_char) -> NwObject;
    }

    /// `nw_proxy_config_create_http_connect`（macOS 14 から）。古い macOS でも起動できるよう、リンクせずに探す。
    fn http_connect_fn() -> Option<unsafe extern "C" fn(NwObject, NwObject) -> NwObject> {
        static F: OnceLock<Option<usize>> = OnceLock::new();
        let p = (*F.get_or_init(|| {
            // SAFETY: 名前は NUL で終わる。見つからなければ null
            let p = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"nw_proxy_config_create_http_connect".as_ptr(),
                )
            };
            (!p.is_null()).then_some(p as usize)
        }))?;
        // SAFETY: 探した関数は、Network.framework の宣言（endpoint と TLS の設定を受けて設定を返す）と同じ型
        Some(unsafe { std::mem::transmute::<*mut c_void, _>(p as *mut c_void) })
    }

    /// 127.0.0.1 の port を HTTP CONNECT のプロキシにする設定。
    fn http_connect_config(port: u16) -> Option<Retained<NSObject>> {
        let create = http_connect_fn()?;
        let host = CString::new("127.0.0.1").ok()?;
        let port = CString::new(port.to_string()).ok()?;
        // SAFETY: 引数は生きている。返るのは retain 済み（+1）のオブジェクトか null
        unsafe {
            let endpoint =
                Retained::from_raw(nw_endpoint_create_host(host.as_ptr(), port.as_ptr()))?;
            Retained::from_raw(create(
                Retained::as_ptr(&endpoint).cast_mut(),
                std::ptr::null_mut(),
            ))
        }
    }

    /// 元のタブ root を port のプロキシに通す WebView の設定を作る。作れなければ、その理由。
    pub async fn configuration(
        app: &AppHandle,
        root: String,
        port: u16,
    ) -> Result<Configuration, String> {
        let main = app.get_webview("main").ok_or("no main webview")?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        main.with_webview(move |pv| {
            let _ = tx.send(configure(&pv, root, port));
        })
        .map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())?
    }

    /// メインスレッドで、データストアと設定を作り、証明書の確認の受け口を足す。
    fn configure(
        pv: &tauri::webview::PlatformWebview,
        root: String,
        port: u16,
    ) -> Result<Configuration, String> {
        let (main, mtm) = crate::browser::wk_webview(pv).ok_or("not on the main thread")?;
        // SAFETY: メインスレッドで呼ぶ（mtm）
        unsafe {
            let store = WKWebsiteDataStore::nonPersistentDataStore(mtm);
            if !store.respondsToSelector(sel!(setProxyConfigurations:)) {
                return Err("the proxy needs macOS 14 or later".into());
            }
            let proxy = http_connect_config(port).ok_or("the proxy needs macOS 14 or later")?;
            if !install_trust_handler(main) {
                return Err("cannot make the page trust the proxy".into());
            }
            let configs = NSArray::from_retained_slice(&[proxy]);
            // proxyConfigurations は NSArray<nw_proxy_config_t>（macOS 14 から。上で確かめた）
            let _: () = msg_send![&store, setProxyConfigurations: &*configs];
            let config = WKWebViewConfiguration::new(mtm);
            config.setWebsiteDataStore(&store);
            STORES.with(|s| {
                let mut s = s.borrow_mut();
                s.retain(|(r, _)| *r != root);
                s.push((root, store));
            });
            Ok(Configuration(config))
        }
    }

    /// 元のタブ root の下のタブが全部閉じた。データストアを忘れる（どのスレッドから呼んでもよい）。
    pub fn forget(app: &AppHandle, root: &str) {
        let root = root.to_string();
        let _ = app.run_on_main_thread(move || {
            STORES.with(|s| s.borrow_mut().retain(|(r, _)| *r != root))
        });
    }

    /// webview が、通しているタブのもの（覚えたデータストアを使っている）か。
    fn is_proxied(webview: &WKWebView) -> bool {
        // SAFETY: メインスレッドで呼ばれる（WKNavigationDelegate の受け口の中）
        let store = unsafe { webview.configuration().websiteDataStore() };
        STORES.with(|s| {
            s.borrow()
                .iter()
                .any(|(_, kept)| std::ptr::eq(Retained::as_ptr(kept), Retained::as_ptr(&store)))
        })
    }

    /// SecTrustRef の指す先（中は見ない）。
    #[repr(C)]
    struct SecTrust {
        _private: [u8; 0],
    }

    // SAFETY: Security.framework の SecTrustRef は `struct __SecTrust *`
    unsafe impl RefEncode for SecTrust {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("__SecTrust", &[]));
    }

    /// NSURLSessionAuthChallengeDisposition の値。
    const USE_CREDENTIAL: isize = 0;
    const DEFAULT_HANDLING: isize = 1;

    /// `webView:didReceiveAuthenticationChallenge:completionHandler:`。通しているタブの、サーバーの証明書の確認にだけ
    /// 「この証明書を使う」と答える（確かめるのはプロキシ）。ほかは、何も足さなかったときと同じ既定の扱いにする。
    unsafe extern "C-unwind" fn did_receive_challenge(
        _this: &AnyObject,
        _cmd: Sel,
        webview: &WKWebView,
        challenge: &AnyObject,
        handler: &Block<dyn Fn(isize, *mut AnyObject)>,
    ) {
        let space: Option<Retained<AnyObject>> = msg_send![challenge, protectionSpace];
        if let Some(space) = space {
            let method: Option<Retained<NSString>> = msg_send![&*space, authenticationMethod];
            let server_trust =
                method.is_some_and(|m| m.to_string() == "NSURLAuthenticationMethodServerTrust");
            if server_trust && is_proxied(webview) {
                let trust: *mut SecTrust = msg_send![&*space, serverTrust];
                if !trust.is_null() {
                    let credential: Option<Retained<AnyObject>> =
                        msg_send![class!(NSURLCredential), credentialForTrust: trust];
                    if let Some(c) = credential {
                        handler.call((USE_CREDENTIAL, Retained::as_ptr(&c).cast_mut()));
                        return;
                    }
                }
            }
        }
        handler.call((DEFAULT_HANDLING, std::ptr::null_mut()));
    }

    /// 証明書の確認の受け口を、wry が webview に付ける WKNavigationDelegate のクラスに足す（1 度だけ）。足せたら true。
    ///
    /// wry はこの受け口を持たず、外から足す口も無い。WebKit は、delegate を webview に付けたときに、受け口があるかを
    /// 調べて覚えるので、通すタブの webview を作る前に足す。それより前に作った webview（メインの画面・ほかのタブ）は
    /// 「無い」と覚えたままで、今までどおり既定の扱いになる。あとから作る webview では呼ばれるが、通しているタブで
    /// なければ既定の扱いを返す。
    /// wry がこの受け口を持つようになっていたら、足さずに false を返す（上書きしない）。
    fn install_trust_handler(main: &WKWebView) -> bool {
        thread_local! {
            static INSTALLED: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
        }
        if let Some(done) = INSTALLED.with(|i| i.get()) {
            return done;
        }
        // SAFETY: メインスレッドで呼ぶ。navigationDelegate は、wry が付けた delegate（無ければ None）
        let done = unsafe {
            let delegate: Option<Retained<AnyObject>> = msg_send![main, navigationDelegate];
            match delegate {
                None => false,
                Some(d) => {
                    let cls = d.class();
                    let sel = sel!(webView:didReceiveAuthenticationChallenge:completionHandler:);
                    if cls.instance_method(sel).is_some() {
                        false
                    } else {
                        // 型は v@:@@@?（戻り値なし・self・_cmd・webview・challenge・completionHandler の block）
                        let imp: Imp = std::mem::transmute::<
                            unsafe extern "C-unwind" fn(
                                &AnyObject,
                                Sel,
                                &WKWebView,
                                &AnyObject,
                                &Block<dyn Fn(isize, *mut AnyObject)>,
                            ),
                            Imp,
                        >(did_receive_challenge);
                        objc2::ffi::class_addMethod(
                            std::ptr::from_ref(cls).cast_mut(),
                            sel,
                            imp,
                            c"v@:@@@?".as_ptr(),
                        )
                        .as_bool()
                    }
                }
            }
        };
        INSTALLED.with(|i| i.set(Some(done)));
        done
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_proxy_is_on_the_loopback() {
        assert_eq!(
            proxy_url(8080).map(|u| u.to_string()),
            Ok("http://127.0.0.1:8080/".to_string())
        );
        assert!(proxy_url(0).is_err());
    }
}
