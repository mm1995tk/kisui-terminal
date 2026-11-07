// 差分モードの CHANGES の一覧（サイドバーのファイルエクスプローラの下）の行を組み立てる。
// 元は shj が知らせる primaryShj.diff（docs/protocol.md の PrimaryDiff）。

import { RpcError } from "../rpc/message.ts";
import type { DiffFile, PrimaryDiff } from "../rpc/protocol.ts";

/** 一覧の行の印：変更 M・追加 A・削除 D・名前変更 R・バイナリ B */
export type ChangeLetter = "M" | "A" | "D" | "R" | "B";

/** CHANGES の一覧の 1 行（1 ファイル） */
export interface ChangeRow {
  /** shj.diff に送る path（shj が知らせた絶対パス） */
  path: string;
  /** ファイル名 */
  name: string;
  /** 名前の前のフォルダ（root の中なら root からの相対、外なら絶対パス）。無ければ "" */
  dir: string;
  letter: ChangeLetter;
  /** 読み上げの言葉 */
  label: string;
  added: number;
  deleted: number;
  /** shj が今差分を出しているファイル */
  selected: boolean;
}

const letters = new Map<string, [ChangeLetter, string]>([
  ["added", ["A", "追加"]],
  ["deleted", ["D", "削除"]],
  ["renamed", ["R", "名前変更"]],
  ["binary", ["B", "バイナリ"]],
]);

/** 状態の言葉を印にする。知らない言葉・無い言葉は「変更」。 */
export function letterOf(status: string | undefined): [ChangeLetter, string] {
  return (status ? letters.get(status) : undefined) ?? ["M", "変更"];
}

/** 一覧の行。root は ワークスペースのルート（その中のファイルは相対パスで出す）。 */
export function changeRows(
  diff: PrimaryDiff,
  root: string | undefined,
): ChangeRow[] {
  const base = root ? (root.endsWith("/") ? root : `${root}/`) : undefined;
  return diff.files.map((f: DiffFile) => {
    const shown =
      base && f.path.startsWith(base) ? f.path.slice(base.length) : f.path;
    const i = shown.lastIndexOf("/");
    const [letter, label] = letterOf(f.status);
    return {
      path: f.path,
      name: i < 0 ? shown : shown.slice(i + 1),
      dir: i < 0 ? "" : shown.slice(0, i),
      letter,
      label,
      added: f.added ?? 0,
      deleted: f.deleted ?? 0,
      selected: f.path === diff.selected,
    };
  });
}

/** shj.diff が断られたときに出す文。 */
export function changeErrorText(path: string, e: unknown): string {
  const why =
    e instanceof RpcError
      ? e.codeName === "not_found"
        ? "一覧にありません（変更が済んだか、差分モードを閉じました）"
        : e.message
      : e instanceof Error
        ? e.message
        : String(e);
  return `${path} の差分を出せませんでした（${why}）`;
}
