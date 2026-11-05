// ファイルの欄の左右の境界（#526）。差分の分割表示と Markdown プレビューの分割は、ペインの並びから見分ける
// （shj が送るペインの id は、差分の元の側が `<パス>:base`、プレビューが `<パス>#preview`）。
// ファイルを 2 つ並べた境界はドラッグで動かさない。

import type { Files, Pane } from "../rpc/protocol.ts";

/** ファイルの欄を左右に分けた境界の種類（差分の分割表示・Markdown プレビューの分割）。 */
export type SplitKind = "diff" | "preview";

/** panes[i - 1] と panes[i] の間の境界の種類。動かせない境界（や境界でないところ）は null。 */
export function splitKindAt(
  panes: readonly Pane[],
  i: number,
): SplitKind | null {
  const left = panes[i - 1];
  const right = panes[i];
  if (!left || !right) return null;
  if (
    left.kind === "diff" &&
    right.kind === "diff" &&
    left.id.endsWith(":base")
  )
    return "diff";
  if (
    left.kind === "text" &&
    right.kind === "preview" &&
    right.id === `${left.id}#preview`
  )
    return "preview";
  return null;
}

/** 今のファイル（カーソルのあるペイン）の左右の境界の種類。無ければ null。 */
export function activeSplit(files: Files | null | undefined): SplitKind | null {
  if (!files) return null;
  for (const i of [files.active, files.active + 1]) {
    const k = splitKindAt(files.panes, i);
    if (k) return k;
  }
  return null;
}
