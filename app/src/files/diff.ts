// 差分のペインの右端の「変更のバー」（E6）。ファイル全体の表示行をペインの高さに縮め、変更のあるところに
// 印を付け、今見えている範囲を薄い背景で示す。shj の core.BarRange・core.BarKinds と、TUI の
// ui/tui/gitdiff_draw.go の changeBar と同じ決め方。shj は GUI がバーを自分で描くとして、
// バーの桁を空けない（core.screenDiffGeom）。

import type { DiffInfo, Hunk } from "../rpc/protocol.ts";

/** バーの 1 つのマス目。 */
export interface BarCell {
  /** このマス目の表示行にある変更。無ければ undefined。違う種類が混ざれば modified */
  kind?: Hunk["kind"];
  /** 今見えている表示行に掛かる */
  view: boolean;
}

/**
 * 高さ h のバーの i 番目のマス目が受け持つ表示行 [lo, hi)。全部で n 行。入るときは 1 行に 1 マス。
 * shj の core.BarRange と同じ。
 */
export function barRange(i: number, h: number, n: number): [number, number] {
  if (h <= 0 || n <= 0) return [0, 0];
  if (n <= h) return [Math.min(i, n), Math.min(i + 1, n)];
  const lo = Math.floor((i * n) / h);
  let hi = Math.floor(((i + 1) * n) / h);
  if (hi <= lo) hi = lo + 1;
  return [Math.min(lo, n), Math.min(hi, n)];
}

/** 差分のペインの、高さ h のバー。 */
export function changeBar(d: DiffInfo, h: number): BarCell[] {
  const hunks = d.hunks ?? [];
  const out: BarCell[] = [];
  for (let i = 0; i < h; i++) {
    const [lo, hi] = barRange(i, h, d.rows);
    let kind: Hunk["kind"] | undefined;
    for (const k of hunks) {
      if (k.end <= lo || k.start >= hi) continue;
      kind = kind === undefined || kind === k.kind ? k.kind : "modified";
    }
    out.push({ kind, view: hi > d.top && lo < d.top + h });
  }
  return out;
}

/** バーの印の色の名前。 */
export function barColor(kind: Hunk["kind"] | undefined): string | undefined {
  switch (kind) {
    case "added":
      return "diff.add.sign";
    case "deleted":
      return "diff.del.sign";
    case "modified":
      return "diff.mod.sign";
  }
  return undefined;
}
