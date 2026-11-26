// 内蔵ブラウザのタブ（browser.rs）に入れるスクリプト（macOS だけ。#204）。ページが自分を閉じたことを、殻に知らせる。
// ページの外の世界（isolated world）で動く。ページのスクリプトは、この世界の変数も関数も見られず、差し替えられないので、
// 殻に知らせるための nonce はここにだけ置く。
// window.close を差し替えるのは、ページの世界で動く browser_close.js。呼ばれると、window に `kisui-close` のイベントを送る。
// ここはそれを受けて、`kisui-close:` の URL を window.open で開こうとする（殻の on_new_window が受けて断る。知らせ方は
// browser_keys.js と同じ）。
// ふつうのブラウザと同じく、閉じてよいのは、ほかのページが開いた窓（window.opener がある）か、履歴が 1 つだけのページ。
// イベントはページのスクリプトも送れるが、起きるのは、ページが window.close() を呼んだときと同じこと（自分のタブを閉じられるだけ）。
// 入れるのは一番上のフレームだけ（ほかのオリジンのフレームは、一番上の window にイベントを送れない）。
// nonce は殻が下の印に埋める。
(() => {
  const nonce = __KISUI_NONCE__;
  window.addEventListener(
    "kisui-close",
    () => {
      if (window.opener == null && history.length > 1) return;
      window.open("kisui-close://close?n=" + nonce, "_blank");
    },
    true,
  );
})();
