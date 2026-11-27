// ターミナルの字 1 つの幅（px）。サイドバーの幅の上限（右のターミナルが 20 列残るところまで。panes.ts の sidebarMax）を、ピクセルに直すのに使う。
//
// ターミナルの列の数は coneko-term が決める（Terminal.fit）。その字の幅は、ASCII の印字できる字（0x20〜0x7e）のうち
// いちばん広い送り幅を、デバイスピクセルで切り上げた整数（÷ devicePixelRatio で CSS ピクセル）。ここの上限が列の数とずれないよう、
// 開いているターミナルがあればその実際の字の幅（reportTermCellWidth で TerminalView が知らせる）を使い、
// まだ無いときは同じ式（measuredCellWidth）で測る。canvas の "W" の幅をそのまま使うと、切り上げの分だけ狭く見積もって 18 列で止まる（#501）。

import { createSignal } from "solid-js";

import { MONO_FONT_FAMILY, TERM_FONT_SIZE } from "../styles/monoFont.ts";

/** 測れないとき（canvas が無い環境）の、11px の等幅の字のおよその幅。 */
const FALLBACK_CELL_WIDTH = 7;

/** ASCII の印字できる字（0x20〜0x7e。coneko-term の PRINTABLE_ASCII と同じ）。 */
const PRINTABLE_ASCII = Array.from({ length: 0x7f - 0x20 }, (_, i) =>
  String.fromCharCode(0x20 + i),
);

/**
 * 字の幅の測り方（coneko-term の CanvasRenderer.measure と同じ）。advance は字 1 つの送り幅（デバイスピクセル）を返す関数、
 * dpr は devicePixelRatio。いちばん広い送り幅を切り上げ、dpr で割った CSS ピクセルの幅。測れなければ undefined。
 */
export function cellWidthFromAdvances(
  advance: (ch: string) => number,
  dpr: number,
): number | undefined {
  const widest = Math.max(
    0,
    ...PRINTABLE_ASCII.map(advance).filter(Number.isFinite),
  );
  const device = Math.ceil(widest - 1e-6);
  if (!(device > 0) || !(dpr > 0)) return undefined;
  return device / dpr;
}

/** 開いているターミナルの実際の字の幅（CSS ピクセル）。無ければ undefined。 */
const [live, setLive] = createSignal<number | undefined>(undefined);

/** 開いたターミナルの実際の字の幅を知らせる（coneko-term の cellSize.width）。以後の termCellWidth はこれを返す。 */
export function reportTermCellWidth(width: number): void {
  if (Number.isFinite(width) && width > 0) setLive(width);
}

let cached: number | undefined;

/** coneko-term と同じ式で測った字の幅。一度測ったら覚える（字体が読めていないとき・測れないときは覚えない）。 */
function measuredCellWidth(): number {
  if (cached !== undefined) return cached;
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return FALLBACK_CELL_WIDTH;
    const dpr = window.devicePixelRatio || 1;
    ctx.font = `${TERM_FONT_SIZE * dpr}px ${MONO_FONT_FAMILY}`;
    const w = cellWidthFromAdvances((t) => ctx.measureText(t).width, dpr);
    if (w === undefined) return FALLBACK_CELL_WIDTH;
    // 字体が読めていないと、並びの次の字体で測った幅が返る。覚えるのは、読めてから
    if (document.fonts?.check(ctx.font)) cached = w;
    return w;
  } catch {
    return FALLBACK_CELL_WIDTH;
  }
}

/** 字 1 つの幅（px）。開いているターミナルの実際の値があればそれ、無ければ同じ式で測った値。 */
export function termCellWidth(): number {
  return live() ?? measuredCellWidth();
}
