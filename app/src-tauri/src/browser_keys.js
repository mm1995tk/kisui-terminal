// 内蔵ブラウザのタブ（browser.rs）のページに入れるスクリプト。ページにキーがある間も、kisui-terminal のリーダーと近道を効かせる。
// ページ（外のサイト）には Tauri の命令を使わせないので、キーは IPC ではなく、`kisui-key:` の URL を window.open で開こうとして
// 殻に知らせる（殻の on_new_window が受けて、開かずに断る）。ページの遷移（URL の書き換え）は使わない（beforeunload を起こさないため）。
// nonce と受けるキーの一覧は、殻が下の 2 つの印に埋める。nonce はこの関数の中にだけ置き、ページのスクリプトからは読めない。
// ページが後から組み込みの関数を差し替えても、nonce を渡さず、キーを見せかけられないよう、使う関数と getter は先に取っておく。
(() => {
  const nonce = __KISUI_NONCE__;
  // [{ ctrl, shift, alt, meta, key, enter }]。enter は、リーダーとグループの入口（押したあとのキーも続けて殻に送る）
  const keys = __KISUI_KEYS__;
  // 組み込みの関数と、キーの中身を読む getter は、ページのスクリプトが差し替える前（ここ）で取っておき、それだけを使う。
  // ページが KeyboardEvent.prototype の key などを差し替えても、本物のキーを別のキーに見せかけて送れないようにするため
  const uncurry = Function.prototype.call.bind.bind(Function.prototype.call);
  const getter = (proto, name) =>
    uncurry(Object.getOwnPropertyDescriptor(proto, name).get);
  const K = KeyboardEvent.prototype;
  const keyOf = getter(K, "key");
  const codeOf = getter(K, "code");
  const ctrlOf = getter(K, "ctrlKey");
  const shiftOf = getter(K, "shiftKey");
  const altOf = getter(K, "altKey");
  const metaOf = getter(K, "metaKey");
  const repeatOf = getter(K, "repeat");
  const composingOf = getter(K, "isComposing");
  const inputTypeOf = getter(InputEvent.prototype, "inputType");
  const dataOf = getter(InputEvent.prototype, "data");
  const preventDefault = uncurry(Event.prototype.preventDefault);
  const stopImmediatePropagation = uncurry(
    Event.prototype.stopImmediatePropagation,
  );
  const lower = uncurry(String.prototype.toLowerCase);
  const upper = uncurry(String.prototype.toUpperCase);
  const charCodeAt = uncurry(String.prototype.charCodeAt);
  const open = uncurry(window.open);
  const enc = encodeURIComponent;
  const addListener = uncurry(window.addEventListener);
  const now = Date.now;
  // リーダーに入ったあと、キーが kisui-terminal の画面に移るまでのキーも送る（速く打つと、移る前に次のキーがページに届く）
  let followUntil = 0;

  /** キーの中身を、取っておいた getter で読む（読んだあとは、ページの差し替えに触れない）。 */
  const read = (e) => ({
    key: "" + keyOf(e),
    code: "" + (codeOf(e) || ""),
    ctrl: !!ctrlOf(e),
    shift: !!shiftOf(e),
    alt: !!altOf(e),
    meta: !!metaOf(e),
    repeat: !!repeatOf(e),
    composing: !!composingOf(e),
  });

  const isKey = (e, k) => {
    const c = e.code;
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
      return lower(e.key) === k || c === "Key" + upper(k);
    return e.key === k;
  };
  // keyspec.ts の matchSpec と同じ判定
  const match = (e, s) => {
    if (e.ctrl !== s.ctrl || e.alt !== s.alt) return false;
    if (e.meta !== s.meta) return false;
    const plus = s.key === "+" || s.key === "=";
    if (!plus && e.shift !== s.shift) return false;
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
      (e.ctrl ? 1 : 0) | (e.shift ? 2 : 0) | (e.alt ? 4 : 0) | (e.meta ? 8 : 0);
    open(
      window,
      "kisui-key://key?n=" +
        nonce +
        "&k=" +
        enc(e.key) +
        "&c=" +
        enc(e.code) +
        "&m=" +
        m +
        "&r=" +
        (e.repeat ? 1 : 0),
      "_blank",
    );
  };

  addListener(
    window,
    "keydown",
    (ev) => {
      // ページのスクリプトが作ったキーは送らない（isTrusted はページが差し替えられない）
      if (!ev.isTrusted) return;
      const e = read(ev);
      if (e.composing) return;
      let hit = null;
      // 配列の反復（Symbol.iterator）はページが差し替えられるので、番号で回す
      for (let i = 0; i < keys.length; i++) {
        if (match(e, keys[i])) {
          hit = keys[i];
          break;
        }
      }
      if (!hit && now() > followUntil) return;
      if (!hit && modifierOnly(e.key)) return;
      preventDefault(ev);
      stopImmediatePropagation(ev);
      if (!hit || hit.enter) followUntil = now() + 1500;
      send(e);
    },
    true,
  );
  // macOS の子の webview（Tauri の add_child）は、カーソルが動けない方向に矢印キーを押すと、矢印キーに使う私用領域の文字
  // （NSUpArrowFunctionKey などの U+F700〜U+F703）をテキストとして入力してしまう（tauri-apps/tauri#10194。空の入力欄ではどの方向にも
  // 動けないので毎回入る）。Tauri の殻には手を入れず、その文字を入れる入力（beforeinput の insertText）だけを止める。
  // macOS が矢印・Home・End・F キーなどに使う関数キーの文字の区画（U+F700〜U+F74F。AppKit の NSUpArrowFunctionKey〜NSModeSwitchFunctionKey）を止める。
  // U+F8FF（Apple のロゴ。Option+Shift+K で打てる）は区画の外なので止めない。keydown は止めないので、
  // カーソルの移動も、ページが矢印キーを受けることも変わらない。貼り付け・日本語入力（insertText ではない種類）は止めない
  addListener(
    window,
    "beforeinput",
    (ie) => {
      if (!ie.isTrusted) return;
      if ("" + inputTypeOf(ie) !== "insertText") return;
      const d = dataOf(ie);
      if (d == null) return;
      const s = "" + d;
      for (let i = 0; i < s.length; i++) {
        const c = charCodeAt(s, i);
        if (c >= 0xf700 && c <= 0xf74f) {
          preventDefault(ie);
          stopImmediatePropagation(ie);
          return;
        }
      }
    },
    true,
  );
  addListener(window, "blur", () => {
    followUntil = 0;
  });
})();
