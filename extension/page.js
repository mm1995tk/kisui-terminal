// 許可サイトのページの中（MAIN world）で動く。ページの navigator.credentials.get / create がパスキー（publicKey）で
// 成功したら、relay.js（拡張機能の側の content script）に知らせる。値（資格情報）は渡さない。
// background.js が、kisui-terminal の設定の passkey_sites のサイトにだけ入れる。
(() => {
  // 型の検査のため、書き換える 2 つの関数と印だけを持つものとして扱う
  const creds =
    /** @type {{ get?: Function, create?: Function, __kisuiPasskey?: boolean } | undefined} */ (
      /** @type {unknown} */ (globalThis.navigator && navigator.credentials)
    );
  if (!creds || creds.__kisuiPasskey) return;
  const EVENT = "kisui-terminal-passkey-success";
  for (const name of /** @type {const} */ (["get", "create"])) {
    const orig = creds[name];
    if (typeof orig !== "function") continue;
    /** @this {unknown} @param {{ publicKey?: unknown } | undefined} options */
    const wrapped = function (options) {
      const p = orig.apply(this, arguments);
      if (options && options.publicKey) {
        Promise.resolve(p).then(
          (cred) => {
            if (cred) document.dispatchEvent(new CustomEvent(EVENT));
          },
          () => {},
        );
      }
      return p;
    };
    try {
      Object.defineProperty(creds, name, {
        value: wrapped,
        configurable: true,
        writable: true,
      });
    } catch {
      // 置き換えられないページでは、手で戻るボタンを使う
    }
  }
  try {
    Object.defineProperty(creds, "__kisuiPasskey", { value: true });
  } catch {
    // 印が付けられなくても動きは同じ
  }
})();
