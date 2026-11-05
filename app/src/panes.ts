// ブロックの境界の大きさ（#526）。マウスのドラッグとリサイズモード（Alt+R）が動かす 4 つの境界の値と、その決まり。
// DOM には触らない（テストできるように）。キーは TUI の ui/tui/resize.go と同じ。
//
// - sidebar：サイドバーとその右の境界（サイドバーの幅 px）。
// - term：ファイルの欄とターミナルの境界（下のブロックの高さ px。IDE モードはターミナル、ターミナルモードはファイルの欄）。
// - diff・preview：ファイルの欄を左右に分けた境界（差分の分割表示・Markdown プレビューの分割。左側の %）。
//   割り方は shj が決める（view.resize の splits）。
// 値は覚えておき、GUI を起動し直しても残す。

import type { KeyValueStore } from "./ssh/machines.ts";
import type { KeyLike } from "./files/input.ts";
import type { SplitKind } from "./files/split.ts";

/** 動かせる境界。サイドバーの右・ファイルの欄とターミナルの間・差分の左右・プレビューの左右。 */
export type Border = "sidebar" | "term" | "diff" | "preview";

/** 4 つの境界の、決めた値。無いものは元の大きさ。 */
export type PaneSizes = Partial<Record<Border, number>>;

/** 元の大きさ。diff・preview の 0 は「半分」（shj が割る）。 */
export const DEFAULT_SIZES: Readonly<Record<Border, number>> = {
  sidebar: 300,
  term: 300,
  diff: 0,
  preview: 0,
};

/** 境界ごとの下限と上限。 */
export const LIMITS: Readonly<Record<Border, readonly [number, number]>> = {
  sidebar: [200, 640],
  term: [120, 4000],
  diff: [1, 99],
  preview: [10, 90],
};

/** 半分のとき（値が 0）の、キーで動かし始める % */
const HALF = 50;

/** キーを 1 回押したときに境界が動く量（px・%）。 */
export const KEY_STEP: Readonly<Record<Border, number>> = {
  sidebar: 20,
  term: 20,
  diff: 2,
  preview: 2,
};

/** `<` `>` を 1 回押したときにプレビューの境界が動く % */
export const PREVIEW_STEP = 5;

const STORAGE_KEY = "shijimi.paneSizes";

/**
 * v を境界 b の範囲に収め、整数に丸める。max は今の画面で効く上限（窓の大きさで決まる。LIMITS より小さいときだけ効く）。
 */
export function clampBorder(b: Border, v: number, max?: number): number {
  const [lo, hi] = LIMITS[b];
  const top = Math.max(lo, Math.min(hi, max ?? hi));
  return Math.min(top, Math.max(lo, Math.round(v)));
}

/** 覚えておいた大きさを読む。壊れていたり範囲外のものは捨てる。 */
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

/** リサイズモードの手がかり。 */
export interface ResizeContext {
  /** キーがターミナルに向いている（ファイルの欄ではない） */
  inTerm: boolean;
  /** ファイルの欄で今のファイルに左右の境界があれば、その種類 */
  split: SplitKind | null;
}

/** ←→（h l）が動かす縦の境界：フォーカスのあるブロックの境界。ファイルの欄に分割の境界があればそれ、無ければサイドバー。 */
export function acrossBorder(c: ResizeContext): Border {
  return !c.inTerm && c.split ? c.split : "sidebar";
}

/** 光らせる境界（←→ の境界と、↑↓ の境界）。 */
export function litBorders(c: ResizeContext): Border[] {
  return [acrossBorder(c), "term"];
}

/** リサイズモードのキーの動き。 */
export type ResizeAction =
  | { kind: "move"; border: Border; step: number } // step は右・下へ動かす向きが正（term は上へ動かすと高さが増える）
  | { kind: "reset" }
  | { kind: "exit" }
  | { kind: "none" };

/** KeyboardEvent を TUI のキーの名前にする（ui/tui の ResizeKey が受ける形）。リサイズモードで使わない組み合わせは null。 */
export function resizeKeyName(e: KeyLike): string | null {
  if (e.ctrlKey || e.metaKey) return null;
  if (e.altKey) {
    return e.code === "KeyR" || e.key.toLowerCase() === "r" ? "alt+r" : null;
  }
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
export function resizeAction(key: string, c: ResizeContext): ResizeAction {
  const across = acrossBorder(c);
  switch (key) {
    case "left":
    case "h":
      return { kind: "move", border: across, step: -KEY_STEP[across] };
    case "right":
    case "l":
      return { kind: "move", border: across, step: KEY_STEP[across] };
    case "up":
    case "k":
      return { kind: "move", border: "term", step: -KEY_STEP.term };
    case "down":
    case "j":
      return { kind: "move", border: "term", step: KEY_STEP.term };
    case "<":
    case ",":
      return preview(c, -PREVIEW_STEP);
    case ">":
    case ".":
      return preview(c, PREVIEW_STEP);
    case "=":
      return { kind: "reset" };
    case "esc":
    case "enter":
    case "q":
    case "alt+r":
      return { kind: "exit" };
  }
  return { kind: "none" };
}

/** `<` `>` はプレビューの境界。無ければ（差分の分割なら）その境界を動かす。どちらも無ければ何もしない。 */
function preview(c: ResizeContext, step: number): ResizeAction {
  return c.split ? { kind: "move", border: c.split, step } : { kind: "none" };
}

/**
 * sizes の動きを当てる。term は上へ動かす（step が負）と高さが増える。max は今の画面で効く上限。
 * 値が上限を超えていたら（窓を狭めたあとなど）上限から動かす（見えない分を動かして反応が無くならないように）。
 */
export function applyMove(
  sizes: PaneSizes,
  border: Border,
  step: number,
  max?: number,
): PaneSizes {
  let cur = sizeOf(sizes, border) || HALF;
  if (max !== undefined) cur = Math.min(cur, max);
  return withSize(
    sizes,
    border,
    border === "term" ? cur - step : cur + step,
    max,
  );
}

/**
 * ファイルの欄の左右の境界を、ポインタの位置から % にする。
 * leftPx は左のペインの左端から境界の左端までの px、totalPx は左右のペインの幅の合計、cellPx は 1 マスの幅。
 * 間の 1 マス（境界）を除いた幅に対する左側の割合。
 */
export function splitPct(
  kind: SplitKind,
  pointerPx: number,
  totalPx: number,
  cellPx: number,
): number {
  const avail = totalPx - cellPx;
  if (avail <= 0) return DEFAULT_SIZES[kind];
  return clampBorder(kind, (pointerPx * 100) / avail);
}
