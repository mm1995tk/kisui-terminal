// Mac で GUI が受ける Cmd のキー（#529）。Linux と Windows は今までどおり Ctrl+Shift（terminal/grid.ts）。
// Option は字を打つキーのまま使うので、Cmd+Option+矢印以外では使わない。Cmd+` は macOS が使うので使わない。
// DOM には触らない（node --test で確かめられる）。

/** KeyboardEvent のうち、ここで使う項目。 */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** 動いている OS が macOS か。 */
export function isMac(platform: string): boolean {
  return /mac|iphone|ipad/i.test(platform);
}

/** Ctrl と Shift だけを押しているか（Alt・Meta は押していない）。GUI が受けるキーはどれもこの形。 */
export function isCtrlShift(e: KeyLike): boolean {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
}

/** 動いている OS が macOS か。 */
export const IS_MAC =
  typeof navigator !== "undefined" &&
  isMac(navigator.platform || navigator.userAgent || "");

/** Cmd だけを押して、文字 k（小文字）を打ったか。code か key のどちらかで見る（配列によって key が違うため）。 */
export function isCmdKey(e: KeyLike, k: string): boolean {
  if (!e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  return e.key.toLowerCase() === k || e.code === `Key${k.toUpperCase()}`;
}

/** Cmd と Shift だけを押して、文字 k（小文字）を打ったか。 */
export function isCmdShiftKey(e: KeyLike, k: string): boolean {
  if (!e.metaKey || !e.shiftKey || e.ctrlKey || e.altKey) return false;
  return e.key.toLowerCase() === k || e.code === `Key${k.toUpperCase()}`;
}

/** Ctrl と Shift だけを押して、文字 k（小文字）を打ったか（Linux の GUI キー）。 */
export function isCtrlShiftKey(e: KeyLike, k: string): boolean {
  if (!isCtrlShift(e)) return false;
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

/** Cmd+Shift+Enter（プライマリ以外の欄を隠す・戻す。iTerm2 の欄の拡大と同じ）か。 */
export function isCmdZoomKey(e: KeyLike): boolean {
  return (
    e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key === "Enter"
  );
}
