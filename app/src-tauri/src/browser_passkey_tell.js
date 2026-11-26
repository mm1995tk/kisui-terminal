// 内蔵ブラウザのタブ（browser.rs）に入れるスクリプト（#206）。ページがパスキーを求めたことを、殻に知らせる。
// ページの外の世界（isolated world）で動く。ページのスクリプトは、この世界の変数も関数も見られず、差し替えられないので、
// 殻に知らせるための nonce はここにだけ置く。
// パスキーを捕まえるのは、ページの世界で動く browser_passkey.js。捕まえると、自分のフレームの window に `kisui-passkey` の
// イベントを送る。ここはそれを受けて、`kisui-passkey:` の URL を window.open で開こうとする（殻の on_new_window が受けて断る。
// 知らせ方は browser_keys.js と同じ）。
// イベントはページのスクリプトも送れるが、起きるのは、ページがパスキーを求めたときと同じこと。受けるのは、設定に書いたサイトの
// フレームだけ（ほかのオリジンのフレームは、このフレームの window にイベントを送れない）。
// nonce・サイトの一覧・続けて知らせない間隔は、殻が下の 3 つの印に埋める。
(() => {
  const nonce = __KISUI_NONCE__;
  // browser_passkey.js と同じ一覧・同じ決まり（殻の passkey.rs の site_matches）
  const sites = __KISUI_PASSKEY_SITES__;
  // 続けて知らせない間隔（ミリ秒。殻の MIN_INTERVAL と同じ値を殻が埋める）
  const interval = __KISUI_PASSKEY_INTERVAL__;
  const host = location.hostname;
  let allowed = false;
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    if (s === host) allowed = true;
    else if (s.charAt(0) === "." && (host === s.slice(1) || host.endsWith(s)))
      allowed = true;
  }
  if (!allowed) return;

  // 続けて送られても、外のブラウザを何度も開かない（殻も同じ間隔で断る）
  let last = 0;
  window.addEventListener(
    "kisui-passkey",
    () => {
      const t = Date.now();
      if (t - last < interval) return;
      last = t;
      try {
        window.open("kisui-passkey://passkey?n=" + nonce, "_blank");
      } catch (_) {
        // 開けなくても、何もしない（ページには browser_passkey.js が「断られた」と返す）
      }
    },
    true,
  );
})();
