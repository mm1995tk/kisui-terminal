// 内蔵ブラウザのタブ（browser.rs）のページに入れるスクリプト（macOS だけ。#204）。ページが自分を閉じたら（window.close()）、殻に知らせる。
// WKWebView は window.close() を殻に知らせない（wry が webViewDidClose を受けない）ので、window.close を差し替える。
// このスクリプトは、ページの世界で動く（ページが呼ぶ window.close を差し替えるため）。ページの世界では、ページのスクリプトが
// 組み込みの関数を差し替えた後に、このスクリプトがもう一度動くことがあるので、殻に知らせるための nonce は持たない。
// 呼ばれたら、window に `kisui-close` のイベントを送るだけ。閉じてよいかを確かめて殻に知らせるのは、ページの外の世界で動く
// browser_close_tell.js（nonce を持つ）。
// Linux（WebKitGTK）は window.close() を殻が直接受けるので、このスクリプトは入れない。
(() => {
  const uncurry = Function.prototype.call.bind.bind(Function.prototype.call);
  const dispatch = uncurry(EventTarget.prototype.dispatchEvent);
  const Ev = Event;
  const close = function () {
    dispatch(window, new Ev("kisui-close"));
  };
  Object.defineProperty(window, "close", {
    value: close,
    writable: true,
    configurable: true,
  });
})();
