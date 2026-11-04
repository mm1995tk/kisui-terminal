// ターミナルモードでターミナルを並べる割り付け（F4）。設計書 docs/design/gui-protocol.md の 6 章 F の表の F4。
//
// - 数に応じて自動で並べる：1 個は全体、2 個は左右、3〜4 個は 2×2、5〜6 個は 3×2。上限は 6 個。
// - 升目が 1 つ余るとき（3 個・5 個）は、最後のターミナルを 2 升ぶんの幅にして空きを作らない。
// - Ctrl+Shift+矢印で隣のターミナルへ移る。上下は、今のターミナルの左端の列にかかる升へ移る。
//
// DOM を使わないので node --test で確かめられる。

import type { KeyLike } from "../files/input.ts";
import { isCtrlShift } from "../mode.ts";

/** 並べられるターミナルの数の上限。 */
export const MAX_TERMS = 6;

/** 隣へ移る向き（Ctrl+Shift+矢印）。 */
export type Direction = "left" | "right" | "up" | "down";

/** n 個を並べる升目の列と行の数。 */
export function gridSize(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  return { cols: 3, rows: 2 };
}

/** 升の位置（0 からの行と列）と、何列ぶんの幅か。 */
export interface Cell {
  row: number;
  col: number;
  span: number;
}

/** n 個を並べたときの i 番目（0 から）の升。最後のターミナルで升目が余れば、残りの幅を全部使う。 */
export function cellOf(i: number, n: number): Cell {
  const { cols, rows } = gridSize(n);
  const row = Math.floor(i / cols);
  const col = i % cols;
  // 最後のターミナルで、升目が余るなら残りの幅を全部使う
  const span = i === n - 1 && n < cols * rows ? cols - col : 1;
  return { row, col, span };
}

/** i 番目から dir の向きの隣のターミナルの番号。隣が無ければ i のまま。 */
export function neighbor(i: number, n: number, dir: Direction): number {
  if (i < 0 || i >= n) return i;
  const here = cellOf(i, n);
  switch (dir) {
    case "left":
      return here.col > 0 ? i - 1 : i;
    case "right":
      return i + 1 < n && cellOf(i + 1, n).row === here.row ? i + 1 : i;
    case "up":
    case "down": {
      const row = here.row + (dir === "up" ? -1 : 1);
      for (let j = 0; j < n; j++) {
        const c = cellOf(j, n);
        if (c.row === row && c.col <= here.col && here.col < c.col + c.span)
          return j;
      }
      return i;
    }
  }
}

/** Ctrl+Shift+矢印なら向き、そうでなければ null。 */
export function directionKey(e: KeyLike): Direction | null {
  if (!isCtrlShift(e)) return null;
  switch (e.key) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    default:
      return null;
  }
}

/** 新しいターミナルを作るキー（Ctrl+Shift+T）か。 */
export function isNewTermKey(e: KeyLike): boolean {
  if (!isCtrlShift(e)) return false;
  return e.code === "KeyT" || e.key === "T" || e.key === "t";
}
