// ターミナルの字 1 つの幅（px）。サイドバーの幅の上限（右のターミナルが 20 列残るところまで。panes.ts の sidebarMax）を、ピクセルに直すのに使う。
// 字は TerminalView.tsx の xterm と同じ字体・大きさ（MONO_FONT_FAMILY・11px）で、canvas に測らせる。

import { MONO_FONT_FAMILY, TERM_FONT_SIZE } from "../styles/monoFont.ts";

/** 測れないとき（canvas が無い環境）の、11px の等幅の字のおよその幅。 */
const FALLBACK_CELL_WIDTH = 6.6;

let cached: number | undefined;

/** 字 1 つの幅（px）。一度測ったら覚えておく。測れなければおよその値（覚えない）。字体がまだ読めていないときは、代わりの字体で測った幅になるので、返すだけで覚えない（読めた後の呼び出しで測り直す）。 */
export function termCellWidth(): number {
  if (cached !== undefined) return cached;
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return FALLBACK_CELL_WIDTH;
    ctx.font = `${TERM_FONT_SIZE}px ${MONO_FONT_FAMILY}`;
    const w = ctx.measureText("W").width;
    if (!Number.isFinite(w) || w <= 0) return FALLBACK_CELL_WIDTH;
    // 字体が読めていないと、並びの次の字体で測った幅が返る。覚えるのは、読めてから
    if (document.fonts?.check(ctx.font)) cached = w;
    return w;
  } catch {
    return FALLBACK_CELL_WIDTH;
  }
}
