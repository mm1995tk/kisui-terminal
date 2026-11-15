// 内蔵ブラウザのタブ（browser.rs）のページに入れるスクリプト（macOS だけ。#204）。ページが自分を閉じたら（window.close()）、殻に知らせる。
// WKWebView は window.close() を殻に知らせない（wry が webViewDidClose を受けない）ので、window.close を差し替える。
// 知らせ方は browser_keys.js と同じ。`kisui-close:` の URL を window.open で開こうとし、殻の on_new_window が受けて断る。
// ふつうのブラウザと同じく、閉じてよいのは、ほかのページが開いた窓（window.opener がある）か、履歴が 1 つだけのページ。
// nonce は殻が下の印に埋める。この関数の中にだけ置き、ページのスクリプトからは読めない。
// Linux（WebKitGTK）は window.close() を殻が直接受けるので、このスクリプトは入れない。
(() => {
  const nonce = __KISUI_NONCE__;
  const uncurry = Function.prototype.call.bind.bind(Function.prototype.call);
  const open = uncurry(window.open);
  const close = function () {
    // ページが window.opener などを差し替えても、自分のタブを閉じられるだけ（ほかのタブには届かない）
    if (window.opener == null && history.length > 1) return;
    open(window, "kisui-close://close?n=" + nonce, "_blank");
  };
  Object.defineProperty(window, "close", {
    value: close,
    writable: true,
    configurable: true,
  });
})();
