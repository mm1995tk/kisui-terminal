// 画面全体の大きさ（#594）。Mac は Cmd = / Cmd + / Cmd - / Cmd 0、そのほかは Ctrl で同じ。
// Tauri の webview の zoom で変える。CSS の px はそのままで窓の幅が狭く（広く）見えるので、
// サイドバー・ツリー・ターミナルが同じ割合で変わり、ターミナルは欄の大きさの変化（ResizeObserver）で合わせ直す。
// DOM にも Tauri にも触らない（テストできるように）。

import type { KeyLike } from "./guiKeys.ts";
import type { KeyValueStore } from "./ssh/machines.ts";

/** 選べる大きさ。1 が元の大きさ。 */
export const SCALES: readonly number[] = [
  0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
];

/** 初めて開いたときの大きさ。Cmd 0 で戻る先。覚えた大きさが無い・壊れているときもこれ。 */
export const DEFAULT_SCALE = 1;

/** 大きさを変える動き。 */
export type ScaleAction = "in" | "out" | "reset";

const STORAGE_KEY = "shijimi.uiScale";

/**
 * 大きさを変えるキーなら、その動き。Mac は Cmd、そのほかは Ctrl（どちらも Alt は押さない）。
 * Shift は + を打つために許す（US 配列の Cmd+Shift+=）。
 * Mac 以外の Ctrl+- は、ターミナルの C-_（readline の undo）を奪うことを承知で選んだ（ブラウザや多くのターミナルと同じ形に揃える）。
 */
export function scaleKey(e: KeyLike, mac: boolean): ScaleAction | null {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey || e.isComposing) return null;
  const c = e.code ?? "";
  if (e.key === "+" || c === "NumpadAdd") return "in";
  if (e.key === "=" || c === "Equal") return "in";
  if (e.shiftKey) return null;
  if (e.key === "-" || c === "Minus" || c === "NumpadSubtract") return "out";
  if (e.key === "0" || c === "Digit0" || c === "Numpad0") return "reset";
  return null;
}

/** 選べる大きさのうち、v に一番近いもの。 */
function nearest(v: number): number {
  return SCALES.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
}

/** 今の大きさ cur に動きを当てた、次の大きさ。端ではそのまま。 */
export function nextScale(cur: number, a: ScaleAction): number {
  if (a === "reset") return DEFAULT_SCALE;
  const i = SCALES.indexOf(nearest(cur));
  const j = Math.min(SCALES.length - 1, Math.max(0, i + (a === "in" ? 1 : -1)));
  return SCALES[j];
}

/** 覚えておいた大きさを読む。無い・壊れている・選べない値は初期値。 */
export function loadScale(store: KeyValueStore | undefined): number {
  try {
    const v = Number(store?.getItem(STORAGE_KEY));
    return SCALES.includes(v) ? v : DEFAULT_SCALE;
  } catch {
    return DEFAULT_SCALE;
  }
}

/** 大きさを覚えておく。書けなくても例外にしない。 */
export function saveScale(store: KeyValueStore | undefined, v: number): void {
  try {
    store?.setItem(STORAGE_KEY, String(v));
  } catch {
    // 覚えられなくても、今の画面は変わらない
  }
}
