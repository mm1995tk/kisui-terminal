// ターミナルの字 1 つの幅（px）。サイドバーの幅の上限（右のターミナルが 20 列残るところまで。panes.ts の sidebarMax）を、ピクセルに直すのに使う。
// 字は TerminalView.tsx の xterm と同じ字体・大きさ（MONO_FONT_FAMILY・11px）で、canvas に測らせる。

import { MONO_FONT_FAMILY } from "../styles/monoFont.ts";

/** TerminalView.tsx の xterm の fontSize と同じ。 */
const TERM_FONT_SIZE = 11;
/** 測れないとき（canvas が無い環境・字体がまだ読めていない）の、11px の等幅の字のおよその幅。 */
const FALLBACK_CELL_WIDTH = 6.6;

let cached: number | undefined;

/** 字 1 つの幅（px）。一度測ったら覚えておく。測れなければおよその値（覚えない）。 */
export function termCellWidth(): number {
  if (cached !== undefined) return cached;
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return FALLBACK_CELL_WIDTH;
    ctx.font = `${TERM_FONT_SIZE}px ${MONO_FONT_FAMILY}`;
    const w = ctx.measureText("W").width;
    if (!Number.isFinite(w) || w <= 0) return FALLBACK_CELL_WIDTH;
    cached = w;
    return w;
  } catch {
    return FALLBACK_CELL_WIDTH;
  }
}
