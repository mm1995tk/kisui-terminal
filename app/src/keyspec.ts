// キーの書き方（"Cmd+Shift+D" のような文字列）と、KeyboardEvent がそれに当たるかの判定。
// コマンドの表（commands.ts）が、近道を文字列で持ち、案内の表示と実際の判定の両方にこれを使う。
// DOM には触らない（node --test で確かめられる）。

import type { KeyLike } from "./guiKeys.ts";

/** 近道 1 つを分けたもの。key は小文字の字か、Enter・Tab・Space・Escape・Backspace・=・-・数字。 */
export interface KeySpec {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

/** "Cmd+Shift+D" を分ける。修飾キーは Cmd・Ctrl・Shift・Alt（Option）。最後の 1 つがキー（"Ctrl+=" の = も）。 */
export function parseSpec(s: string): KeySpec {
  const parts = s.split("+");
  // 最後が空なら、キーが + 自身（"Ctrl++"）
  const key = parts[parts.length - 1] === "" ? "+" : parts[parts.length - 1];
  const mods = new Set(
    parts.slice(0, parts[parts.length - 1] === "" ? -2 : -1),
  );
  for (const m of mods)
    if (!["Cmd", "Ctrl", "Shift", "Alt"].includes(m))
      throw new Error(`キーの書き方が読めません: ${s}`);
  return {
    ctrl: mods.has("Ctrl"),
    shift: mods.has("Shift"),
    alt: mods.has("Alt"),
    meta: mods.has("Cmd"),
    key: key.length === 1 ? key.toLowerCase() : key,
  };
}

/** 修飾キーを押さずに、字のキー k を打ったか。code か key のどちらかで見る（配列や入力方式によって key が違うため）。 */
export function isKey(e: KeyLike, k: string): boolean {
  const c = e.code ?? "";
  switch (k) {
    case "+":
    case "=":
      return (
        e.key === "+" || e.key === "=" || c === "Equal" || c === "NumpadAdd"
      );
    case "-":
      return e.key === "-" || c === "Minus" || c === "NumpadSubtract";
    case "Enter":
      return e.key === "Enter";
    case "Tab":
    case "Escape":
    case "Backspace":
      return e.key === k;
    case "Space":
      return e.key === " " || c === "Space";
  }
  if (/^[0-9]$/.test(k))
    return e.key === k || c === `Digit${k}` || c === `Numpad${k}`;
  if (k.length === 1 && /[a-z]/.test(k))
    return e.key.toLowerCase() === k || c === `Key${k.toUpperCase()}`;
  return e.key === k;
}

/**
 * e が spec に当たるか。修飾キーは spec のとおり（多くても少なくても外れる）。
 * 例外：キーが + か = の近道は、Shift を押していても押していなくても当たる（US 配列の + は Shift を伴うため）。
 * かな漢字変換中は当たらない。
 */
export function matchSpec(e: KeyLike, spec: KeySpec): boolean {
  if (e.isComposing) return false;
  if (!!e.ctrlKey !== spec.ctrl || !!e.altKey !== spec.alt) return false;
  if (!!e.metaKey !== spec.meta) return false;
  const plus = spec.key === "+" || spec.key === "=";
  if (!plus && !!e.shiftKey !== spec.shift) return false;
  return isKey(e, spec.key);
}

/** 修飾キーだけのキーか（押している途中。リーダーの中で、これを押しただけでは出ない）。 */
export function isModifierOnly(e: { key: string }): boolean {
  return [
    "Shift",
    "Control",
    "Alt",
    "Meta",
    "AltGraph",
    "CapsLock",
    "OS",
  ].includes(e.key);
}
