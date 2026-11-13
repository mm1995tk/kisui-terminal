// サイドバーとターミナルの境界の大きさ（#526）。マウスのドラッグとリサイズモード（Cmd+R / Ctrl+Shift+R）が動かす境界の値と、その決まり。
// DOM には触らない（テストできるように）。キーは TUI の ui/tui/resize.go と同じ。
//
// - sidebar：サイドバーとその右の境界（サイドバーの幅 px）。値は覚えておき、GUI を起動し直しても残す。
// - changes：サイドバーの中の、ファイルツリーと CHANGES の境目（#152）。決めるのは CHANGES の一覧の高さ（px）で、上へ動かすと高くなる。値は覚えておく。
// - 右の欄の中の、欄どうしの境界（#18）：割合は kisui serve が分割の木に持つ（terminal/grid.ts）。ここは動かすキーだけを決める。
// キー：Tab / Shift+Tab で動かす境界を替え、←→（h l）か↑↓（k j）で動かす。縦の境界は左右、横の境界は上下だけ効く。

import type { KeyValueStore } from "./ssh/machines.ts";
import { shortcutCommand } from "./commands.ts";
import type { KeyLike } from "./guiKeys.ts";

/** 動かせる境界。サイドバーの右（sidebar）と、サイドバーの中のファイルツリーと CHANGES の境目（changes）。 */
export type Border = "sidebar" | "changes";

/** 境界の、決めた値。無いものは元の大きさ。 */
export type PaneSizes = Partial<Record<Border, number>>;

/** 元の大きさ。 */
export const DEFAULT_SIZES: Readonly<Record<Border, number>> = {
  sidebar: 300,
  changes: 143, // 6 行半（changes.css の元の上限）
};

/** 境界ごとの下限と上限。 */
export const LIMITS: Readonly<Record<Border, readonly [number, number]>> = {
  sidebar: [200, 640],
  changes: [44, 640], // 下限は 2 行
};

/** キーを 1 回押したときに境界が動く量（px）。 */
export const KEY_STEP: Readonly<Record<Border, number>> = {
  sidebar: 20,
  changes: 22, // 1 行（行の高さ）
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

/** リサイズモードのキーの動き。 */
export type ResizeAction =
  | { kind: "nudge"; axis: "x" | "y"; sign: 1 | -1 } // 選んでいる境界を動かす。x は右・y は下が正
  | { kind: "select"; step: 1 | -1 } // 動かす境界を次・前へ替える（Tab・Shift+Tab）
  | { kind: "reset" }
  | { kind: "exit" }
  | { kind: "none" };

/** KeyboardEvent を TUI のキーの名前にする（ui/tui の ResizeKey が受ける形）。リサイズモードで使わない組み合わせは null。 */
export function resizeKeyName(e: KeyLike, mac = false): string | null {
  // 入る・出るキー：コマンドの表の pane.resize の近道（Mac は Cmd+R、それ以外は Ctrl+Shift+R）。Alt+R は端末（shj）に渡すので取らない
  if (shortcutCommand(e, mac)?.id === "pane.resize") return "mod+r";
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
    case "Tab":
      return e.shiftKey ? "shift+tab" : "tab";
  }
  return e.key.length === 1 ? e.key : null;
}

/** リサイズモードで key（resizeKeyName の名前）を押したときの動き。 */
export function resizeAction(key: string): ResizeAction {
  switch (key) {
    case "left":
    case "h":
      return { kind: "nudge", axis: "x", sign: -1 };
    case "right":
    case "l":
      return { kind: "nudge", axis: "x", sign: 1 };
    case "up":
    case "k":
      return { kind: "nudge", axis: "y", sign: -1 };
    case "down":
    case "j":
      return { kind: "nudge", axis: "y", sign: 1 };
    case "tab":
      return { kind: "select", step: 1 };
    case "shift+tab":
      return { kind: "select", step: -1 };
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

/** リサイズモードで、ファイルツリーと CHANGES の境目の名前（動かす境界を替える Tab の順に入る。ペインどうしの境界のキーとは別の名前）。 */
export const CHANGES_BORDER = "@changes";

/** リサイズモードで、欄どうしの境界を 1 回のキーで動かす割合（動かす節の幅か高さに対する割合）。 */
export const SPLIT_KEY_STEP = 0.02;

const SIDEBAR_OPEN_KEY = "kisui.sidebarOpen";

/** サイドバーが開いているか（リーダーの b で開け閉めする）。覚えていなければ・壊れていれば開いている。 */
export function loadSidebarOpen(store: KeyValueStore | undefined): boolean {
  try {
    return store?.getItem(SIDEBAR_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

/** サイドバーの開け閉めを覚えておく。書けなくても例外にしない。 */
export function saveSidebarOpen(
  store: KeyValueStore | undefined,
  open: boolean,
): void {
  try {
    store?.setItem(SIDEBAR_OPEN_KEY, open ? "1" : "0");
  } catch {
    // 覚えられなくても、今の画面は変わらない
  }
}
