// 内蔵ブラウザのタブ（browser.rs）のページに入れるスクリプト。ページにキーがある間も、kisui-terminal のリーダーと近道を効かせる。
// ページ（外のサイト）には Tauri の命令を使わせないので、キーは IPC ではなく、`kisui-key:` の URL を window.open で開こうとして
// 殻に知らせる（殻の on_new_window が受けて、開かずに断る）。ページの遷移（URL の書き換え）は使わない（beforeunload を起こさないため）。
// nonce と受けるキーの一覧は、殻が下の 2 つの印に埋める。nonce はこの関数の中にだけ置き、ページのスクリプトからは読めない。
// ページが後から組み込みの関数を差し替えても nonce を渡さないよう、使う関数は先に取っておく。
(() => {
  const nonce = __KISUI_NONCE__;
  // [{ ctrl, shift, alt, meta, key, enter }]。enter は、リーダーとグループの入口（押したあとのキーも続けて殻に送る）
  const keys = __KISUI_KEYS__;
  const open = window.open.bind(window);
  const enc = encodeURIComponent;
  const addListener = window.addEventListener.bind(window);
  const now = Date.now;
  // リーダーに入ったあと、キーが kisui-terminal の画面に移るまでのキーも送る（速く打つと、移る前に次のキーがページに届く）
  let followUntil = 0;

  const isKey = (e, k) => {
    const c = e.code || "";
    switch (k) {
      case "+":
      case "=":
        return (
          e.key === "+" || e.key === "=" || c === "Equal" || c === "NumpadAdd"
        );
      case "-":
        return e.key === "-" || c === "Minus" || c === "NumpadSubtract";
      case "Enter":
      case "Tab":
      case "Escape":
      case "Backspace":
        return e.key === k;
      case "Space":
        return e.key === " " || c === "Space";
    }
    if (k.length === 1 && k >= "0" && k <= "9")
      return e.key === k || c === "Digit" + k || c === "Numpad" + k;
    if (k.length === 1 && k >= "a" && k <= "z")
      return (
        e.key.toLowerCase() === k || c === "Key" + k.toUpperCase()
      );
    return e.key === k;
  };
  // keyspec.ts の matchSpec と同じ判定
  const match = (e, s) => {
    if (!!e.ctrlKey !== s.ctrl || !!e.altKey !== s.alt) return false;
    if (!!e.metaKey !== s.meta) return false;
    const plus = s.key === "+" || s.key === "=";
    if (!plus && !!e.shiftKey !== s.shift) return false;
    return isKey(e, s.key);
  };
  const modifierOnly = (k) =>
    k === "Shift" ||
    k === "Control" ||
    k === "Alt" ||
    k === "Meta" ||
    k === "AltGraph" ||
    k === "CapsLock" ||
    k === "OS";

  const send = (e) => {
    const m =
      (e.ctrlKey ? 1 : 0) |
      (e.shiftKey ? 2 : 0) |
      (e.altKey ? 4 : 0) |
      (e.metaKey ? 8 : 0);
    open(
      "kisui-key://key?n=" +
        nonce +
        "&k=" +
        enc(String(e.key)) +
        "&c=" +
        enc(String(e.code || "")) +
        "&m=" +
        m +
        "&r=" +
        (e.repeat ? 1 : 0),
      "_blank",
    );
  };

  addListener(
    "keydown",
    (e) => {
      // ページのスクリプトが作ったキーは送らない
      if (!e.isTrusted || e.isComposing) return;
      let hit = null;
      for (const s of keys) {
        if (match(e, s)) {
          hit = s;
          break;
        }
      }
      if (!hit && now() > followUntil) return;
      if (!hit && modifierOnly(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (hit && hit.enter) followUntil = now() + 1500;
      else if (!hit) followUntil = now() + 1500;
      send(e);
    },
    true,
  );
  addListener("blur", () => {
    followUntil = 0;
  });
})();
