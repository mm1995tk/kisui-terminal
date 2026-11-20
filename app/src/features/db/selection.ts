// DB のタブの結果の表で、マウスで選んだセルの範囲（#372）。選んだ範囲から、コピーする文字（TSV）を作る。
// 画面にも Tauri にも触らない（node --test で確かめられる）。
//
// コピーする文字（Issue で「作業役が決めてよい」とされた細部）：
// - セル 1 つは、その値そのままの文字（引用符で囲まない。空の文字列は空）。
// - 2 つ以上のセルは TSV（列は tab、行は LF。最後の行に行の終わりは付けない）。書き出しの TSV（export.ts）と同じく、
//   NULL は空のセル、空の文字列は `""`、tab・`"`・改行を含む値は `"` で囲む（表計算の貼り付けが読める形）。
// - 見出しの行は含めない（選んだセルだけ）。

import type { DbQueryResult } from "../../infrastructure/rpc/protocol.ts";
import { field } from "./export.ts";

/** 表の中のセルの場所（行と列は 0 から。見出しは含めない）。 */
export interface CellPos {
  row: number;
  col: number;
}

/** 選んだ範囲。anchor は押した場所、focus は広げた先（同じなら、セル 1 つ）。 */
export interface CellRange {
  anchor: CellPos;
  focus: CellPos;
}

/** 範囲の左上と右下（anchor と focus の向きによらない）。 */
export function bounds(r: CellRange): {
  top: number;
  left: number;
  bottom: number;
  right: number;
} {
  return {
    top: Math.min(r.anchor.row, r.focus.row),
    left: Math.min(r.anchor.col, r.focus.col),
    bottom: Math.max(r.anchor.row, r.focus.row),
    right: Math.max(r.anchor.col, r.focus.col),
  };
}

/** セル p が範囲 r の中にあるか。 */
export function inRange(r: CellRange | null, p: CellPos): boolean {
  if (r === null) return false;
  const b = bounds(r);
  return (
    p.row >= b.top && p.row <= b.bottom && p.col >= b.left && p.col <= b.right
  );
}

/** 範囲を表の大きさに収める（結果が入れ替わった・行が減ったときの備え）。収まるセルが無ければ null。 */
export function clampRange(
  r: CellRange | null,
  result: DbQueryResult,
): CellRange | null {
  if (r === null || result.rows.length === 0 || result.columns.length === 0) {
    return null;
  }
  const c = (p: CellPos): CellPos => ({
    row: Math.min(Math.max(p.row, 0), result.rows.length - 1),
    col: Math.min(Math.max(p.col, 0), result.columns.length - 1),
  });
  return { anchor: c(r.anchor), focus: c(r.focus) };
}

/** 範囲 r のセルを、コピーする文字にする。 */
export function rangeText(result: DbQueryResult, r: CellRange): string {
  const b = bounds(r);
  const cell = (row: number, col: number) => result.rows[row]?.[col] ?? null;
  if (b.top === b.bottom && b.left === b.right) {
    return cell(b.top, b.left) ?? "";
  }
  const lines: string[] = [];
  for (let row = b.top; row <= b.bottom; row++) {
    const cells: string[] = [];
    for (let col = b.left; col <= b.right; col++) {
      cells.push(field(cell(row, col), "\t"));
    }
    lines.push(cells.join("\t"));
  }
  return lines.join("\n");
}
