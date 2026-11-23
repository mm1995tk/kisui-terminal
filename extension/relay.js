// 許可サイトのページの横（拡張機能の側の content script）で動く。page.js の知らせを background.js に渡す。
// ページは同じ知らせを真似られるが、background.js は kisui-terminal が開いたタブの知らせしか使わず、
// できるのは「そのサイトの Cookie を、待っている kisui-terminal に今送る」ことまで。
(() => {
  // 登録したものと、タブを覚えたときに入れたもの（background.js の track）の 2 回入ることがある
  if (globalThis.__kisuiRelay) return;
  globalThis.__kisuiRelay = true;
  const api = browser;
  document.addEventListener("kisui-terminal-passkey-success", () => {
    api.runtime.sendMessage({ type: "passkey-success" }).catch(() => {});
  });
})();
