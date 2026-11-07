// サイドバーとターミナルの境界の大きさ（#526）。マウスのドラッグとリサイズモード（Cmd+R / Ctrl+Shift+R）が動かす境界の値と、その決まり。
// DOM には触らない（テストできるように）。キーは TUI の ui/tui/resize.go と同じ。
//
// - sidebar：サイドバーとその右の境界（サイドバーの幅 px）。
// 値は覚えておき、GUI を起動し直しても残す。右の欄はターミナルを自動で並べる（terminal/grid.ts）ので、
// ほかに動かせる境界は無い。

import type { KeyValueStore } from "./ssh/machines.ts";
import { isCmdKey, isCtrlShift, type KeyLike } from "./guiKeys.ts";

/** 動かせる境界。サイドバーの右。 */
export type Border = "sidebar";

/** 境界の、決めた値。無いものは元の大きさ。 */
export type PaneSizes = Partial<Record<Border, number>>;

/** 元の大きさ。 */
export const DEFAULT_SIZES: Readonly<Record<Border, number>> = {
  sidebar: 300,
};

/** 境界ごとの下限と上限。 */
export const LIMITS: Readonly<Record<Border, readonly [number, number]>> = {
  sidebar: [200, 640],
};

/** キーを 1 回押したときに境界が動く量（px）。 */
export const KEY_STEP: Readonly<Record<Border, number>> = {
  sidebar: 20,
};

const STORAGE_KEY = "shijimi.paneSizes";

/**
 * v を境界 b の範囲に収め、整数に丸める。max は今の画面で効く上限（窓の大きさで決まる。LIMITS より小さいときだけ効く）。
 */
export function clampBorder(b: Border, v: number, max?: number): number {
  const [lo, hi] = LIMITS[b];
  const top = Math.max(lo, Math.min(hi, max ?? hi));
  return Math.min(top, Math.max(lo, Math.round(v)));
}

/** 覚えておいた大きさを読む。壊れていたり範囲外のものは捨てる（前の版が覚えた term・diff・preview も捨てる）。 */
export function loadSizes(store: KeyValueStore | undefined): PaneSizes {
  let raw: unknown;
  try {
    const s = store?.getItem(STORAGE_KEY);
    raw = s ? JSON.parse(s) : null;
  } catch {
    return {};
  }
  const out: PaneSizes = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const b of Object.keys(LIMITS) as Border[]) {
    const v = (raw as Record<string, unknown>)[b];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const [lo, hi] = LIMITS[b];
    if (v >= lo && v <= hi) out[b] = v;
  }
  return out;
}

/** 大きさを覚えておく。書けなくても例外にしない。 */
export function saveSizes(
  store: KeyValueStore | undefined,
  sizes: PaneSizes,
): void {
  try {
    store?.setItem(STORAGE_KEY, JSON.stringify(sizes));
  } catch {
    // 覚えられなくても、今の画面は変わらない
  }
}

/** 境界 b の今の値（決めていなければ元の大きさ）。 */
export function sizeOf(sizes: PaneSizes, b: Border): number {
  return sizes[b] ?? DEFAULT_SIZES[b];
}

/** sizes の b を v にしたもの（範囲に収める）。 */
export function withSize(
  sizes: PaneSizes,
  b: Border,
  v: number,
  max?: number,
): PaneSizes {
  return { ...sizes, [b]: clampBorder(b, v, max) };
}

/** 境界 b を元の大きさに戻したもの。 */
export function withoutSize(sizes: PaneSizes, b?: Border): PaneSizes {
  if (!b) return {};
  const { [b]: _, ...rest } = sizes;
  return rest;
}

/** 光らせる境界（リサイズモードで動かすもの）。 */
export function litBorders(): Border[] {
  return ["sidebar"];
}

/** リサイズモードのキーの動き。 */
export type ResizeAction =
  | { kind: "move"; border: Border; step: number } // step は右へ動かす向きが正
  | { kind: "reset" }
  | { kind: "exit" }
  | { kind: "none" };

function isRKey(e: KeyLike): boolean {
  return e.code === "KeyR" || e.key.toLowerCase() === "r";
}

/** KeyboardEvent を TUI のキーの名前にする（ui/tui の ResizeKey が受ける形）。リサイズモードで使わない組み合わせは null。 */
export function resizeKeyName(e: KeyLike, mac = false): string | null {
  // 入る・出るキー：Mac は Cmd+R、それ以外は Ctrl+Shift+R。Alt+R は端末（shj）に渡すので取らない
  if (mac ? isCmdKey(e, "r") : isCtrlShift(e) && isRKey(e)) return "mod+r";
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "Escape":
      return "esc";
    case "Enter":
      return "enter";
  }
  return e.key.length === 1 ? e.key : null;
}

/** リサイズモードで key（resizeKeyName の名前）を押したときの動き。 */
export function resizeAction(key: string): ResizeAction {
  switch (key) {
    case "left":
    case "h":
      return { kind: "move", border: "sidebar", step: -KEY_STEP.sidebar };
    case "right":
    case "l":
      return { kind: "move", border: "sidebar", step: KEY_STEP.sidebar };
    case "=":
      return { kind: "reset" };
    case "esc":
    case "enter":
    case "q":
    case "mod+r":
      return { kind: "exit" };
  }
  return { kind: "none" };
}

/**
 * sizes の動きを当てる。max は今の画面で効く上限。
 * 値が上限を超えていたら（窓を狭めたあとなど）上限から動かす（見えない分を動かして反応が無くならないように）。
 */
export function applyMove(
  sizes: PaneSizes,
  border: Border,
  step: number,
  max?: number,
): PaneSizes {
  let cur = sizeOf(sizes, border);
  if (max !== undefined) cur = Math.min(cur, max);
  return withSize(sizes, border, cur + step, max);
}
