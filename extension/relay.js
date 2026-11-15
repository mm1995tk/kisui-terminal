// 許可サイトのページの横（拡張機能の側の content script）で動く。page.js の知らせを background.js に渡す。
// ページは同じ知らせを真似られるが、background.js は kisui-terminal が開いたタブの知らせしか使わず、
// できるのは「そのサイトの Cookie を、待っている kisui-terminal に今送る」ことまで。
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  document.addEventListener("kisui-terminal-passkey-success", () => {
    api.runtime.sendMessage({ type: "passkey-success" }).catch(() => {});
  });
})();
