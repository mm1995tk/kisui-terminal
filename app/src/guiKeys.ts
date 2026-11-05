// Mac で GUI が受ける Cmd のキー（#529）。Linux と Windows は今までどおり Ctrl+Shift（mode.ts・terminal/grid.ts）。
// Option は字を打つキーのまま使うので、Cmd+Option+矢印以外では使わない。Cmd+` は macOS が使うので使わない。
// DOM には触らない（node --test で確かめられる）。

import { isMac, type KeyLike } from "./files/input.ts";

/** 動いている OS が macOS か。 */
export const IS_MAC =
  typeof navigator !== "undefined" &&
  isMac(navigator.platform || navigator.userAgent || "");

/** Cmd だけを押して、文字 k（小文字）を打ったか。code か key のどちらかで見る（配列によって key が違うため）。 */
export function isCmdKey(e: KeyLike, k: string): boolean {
  if (!e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  return e.key.toLowerCase() === k || e.code === `Key${k.toUpperCase()}`;
}

/** Cmd と Option だけを押しているか（Cmd+Option+矢印の形）。 */
export function isCmdOptionKey(e: KeyLike): boolean {
  return e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey;
}

/** Cmd+1〜9 なら 0〜8、そうでなければ null（ワークスペースを上から順に選ぶ）。 */
export function cmdDigit(e: KeyLike): number | null {
  if (!e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code ?? "");
  const d = m ? m[1] : /^[1-9]$/.test(e.key) ? e.key : null;
  return d ? Number(d) - 1 : null;
}

/** Cmd+W（分割したターミナルを閉じる）か。 */
export function isCloseTermKey(e: KeyLike, mac = false): boolean {
  return mac && isCmdKey(e, "w");
}

/** どこでも GUI が受ける Cmd のキー（ターミナルを足す・モードの切り替え・ワークスペースの切り替え）か。shj に送らない。 */
export function isCmdGuiKey(e: KeyLike): boolean {
  return isCmdKey(e, "t") || isCmdKey(e, "j") || cmdDigit(e) !== null;
}
