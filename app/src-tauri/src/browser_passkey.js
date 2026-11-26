// 内蔵ブラウザのタブ（browser.rs）のページに入れるスクリプト（#206）。パスキーを求められたら、外のブラウザに移る。
// OS の WebView では iCloud キーチェーンや 1Password のパスキーを使えないので、設定の `[gui.browser] passkey_sites` に書いた
// サイトのページが navigator.credentials.get / create でパスキー（publicKey）を求めたら、それを捕まえて殻に知らせる。
// 殻は同じ URL を外のブラウザ（Firefox）で開き、ログインした後の Cookie を受け取って戻る（passkey.rs）。
// このスクリプトは、ページの世界で動く（ページが呼ぶ navigator.credentials を差し替えるため）。ページの世界では、ページの
// スクリプトが組み込みの関数を差し替えた後に、このスクリプトがもう一度動くことがあるので、殻に知らせるための nonce は持たない。
// 捕まえたら、自分のフレームの window に `kisui-passkey` のイベントを送るだけ。受けて殻に知らせるのは、ページの外の世界で動く
// browser_passkey_tell.js（nonce を持つ）。ページのスクリプトが同じイベントを自分で送っても、起きるのは、パスキーを求めたときと
// 同じこと（許可サイトのフレームからだけ、間隔を空けて、外のブラウザに移る）。
// サイトの一覧は、殻が下の印に埋める。書いていないサイトでは何も変えない。
(() => {
  // ["github.com", ".google.com", ...]。`github.com` はページの host と完全に同じものだけ、`.google.com` は google.com と
  // そのすべてのサブドメインに当たる（殻の passkey.rs の site_matches と同じ決まり）
  const sites = __KISUI_PASSKEY_SITES__;
  const host = location.hostname;
  let allowed = false;
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    if (s === host) allowed = true;
    else if (s.charAt(0) === "." && (host === s.slice(1) || host.endsWith(s)))
      allowed = true;
  }
  if (!allowed) return;

  // 組み込みの関数は、ページのスクリプトが差し替える前（ここ）で取っておく（差し替えられても、パスキーを捕まえ続けるため）
  const uncurry = Function.prototype.call.bind.bind(Function.prototype.call);
  const dispatch = uncurry(EventTarget.prototype.dispatchEvent);
  const Ev = Event;
  const apply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const addListener = uncurry(EventTarget.prototype.addEventListener);
  const P = Promise;
  const reject = (e) => P.reject(e);
  const DOMEx = DOMException;

  /** ページの外の世界のスクリプトに知らせる。そこから殻に伝わり、殻は今のタブの URL（一番上のフレームのもの）を外のブラウザで開く。 */
  const handOff = () => {
    try {
      dispatch(window, new Ev("kisui-passkey"));
    } catch (_) {
      // 知らせられなくても、ページには「断られた」と返す
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
