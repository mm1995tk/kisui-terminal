// 内蔵ブラウザのタブ（browser.rs）のページに入れるスクリプト（#206）。パスキーを求められたら、外のブラウザに移る。
// OS の WebView では iCloud キーチェーンや 1Password のパスキーを使えないので、設定の `[gui.browser] passkey_sites` に書いた
// サイトのページが navigator.credentials.get / create でパスキー（publicKey）を求めたら、それを捕まえて殻に知らせる。
// 殻は同じ URL を外のブラウザ（Chrome か Firefox）で開き、ログインした後の Cookie を受け取って戻る（passkey.rs）。
// 知らせ方は browser_keys.js と同じ。`kisui-passkey:` の URL を window.open で開こうとし、殻の on_new_window が受けて断る。
// nonce とサイトの一覧は、殻が下の 2 つの印に埋める。nonce はこの関数の中にだけ置き、ページのスクリプトからは読めない。
// 書いていないサイトでは何も変えない。
(() => {
  const nonce = __KISUI_NONCE__;
  // ["github.com", ...]。ページの host と完全に同じものだけ
  const sites = __KISUI_PASSKEY_SITES__;
  // 続けて知らせない間隔（ミリ秒。殻の MIN_INTERVAL と同じ値を殻が埋める）
  const interval = __KISUI_PASSKEY_INTERVAL__;
  const host = location.hostname;
  let allowed = false;
  for (let i = 0; i < sites.length; i++) {
    if (sites[i] === host) allowed = true;
  }
  if (!allowed) return;

  // 組み込みの関数は、ページのスクリプトが差し替える前（ここ）で取っておく
  const uncurry = Function.prototype.call.bind.bind(Function.prototype.call);
  const open = uncurry(window.open);
  const apply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const addListener = uncurry(EventTarget.prototype.addEventListener);
  const P = Promise;
  const reject = (e) => P.reject(e);
  const DOMEx = DOMException;
  const now = Date.now;
  // 続けて呼ばれても、外のブラウザを何度も開かない（殻も同じ間隔で断る）
  let last = 0;

  /** 殻に知らせる。殻は今のタブの URL（一番上のフレームのもの）を外のブラウザで開く。 */
  const handOff = () => {
    const t = now();
    if (t - last < interval) return;
    last = t;
    try {
      open(window, "kisui-passkey://passkey?n=" + nonce, "_blank");
    } catch (_) {
      // 開けなくても、ページには「断られた」と返す
    }
  };

  const moved = () =>
    new DOMEx(
      "kisui-terminal: the passkey is used in your external browser",
      "NotAllowedError",
    );

  /** 決まらないまま待つ（入力欄の候補に出すパスキー。中止されたら AbortError で終える）。 */
  const pending = (signal) =>
    new P((_, rej) => {
      if (!signal) return;
      if (signal.aborted) {
        rej(new DOMEx("aborted", "AbortError"));
        return;
      }
      addListener(signal, "abort", () =>
        rej(new DOMEx("aborted", "AbortError")),
      );
    });

  /** パスキーを求める呼び出しだけを捕まえ、ほかは元の関数に渡す。 */
  const wrap = (orig) =>
    function (options) {
      if (options && typeof options === "object" && options.publicKey) {
        // 入力欄の候補（mediation: "conditional"）はページを開いただけで呼ばれるので、外のブラウザに移らない
        if (options.mediation === "conditional") return pending(options.signal);
        handOff();
        return reject(moved());
      }
      if (typeof orig === "function") return apply(orig, this, arguments);
      return reject(new DOMEx("not supported", "NotSupportedError"));
    };

  const C = window.CredentialsContainer;
  if (C && C.prototype) {
    for (const name of ["get", "create"]) {
      defineProperty(C.prototype, name, {
        value: wrap(C.prototype[name]),
        writable: true,
        configurable: true,
      });
    }
  } else if (!navigator.credentials) {
    // WebView が navigator.credentials を持たないとき（WebKitGTK）は、パスキーのボタンを出してもらえるように足す
    const credentials = {
      get: wrap(null),
      create: wrap(null),
      store: () => reject(new DOMEx("not supported", "NotSupportedError")),
      preventSilentAccess: () => P.resolve(),
    };
    defineProperty(Navigator.prototype, "credentials", {
      get: () => credentials,
      configurable: true,
    });
  }

  // パスキーを使えると答える（使えないと答えると、ページがパスキーのボタンを出さない）。
  // 入力欄の候補（conditional）は使えないと答える（ページを開いただけで外のブラウザに移らないように）
  const yes = () => P.resolve(true);
  const no = () => P.resolve(false);
  let PKC = window.PublicKeyCredential;
  if (typeof PKC !== "function") {
    PKC = function PublicKeyCredential() {
      throw new TypeError("Illegal constructor");
    };
    defineProperty(window, "PublicKeyCredential", {
      value: PKC,
      writable: true,
      configurable: true,
    });
  }
  for (const [name, f] of [
    ["isUserVerifyingPlatformAuthenticatorAvailable", yes],
    ["isConditionalMediationAvailable", no],
  ]) {
    defineProperty(PKC, name, { value: f, writable: true, configurable: true });
  }
})();
