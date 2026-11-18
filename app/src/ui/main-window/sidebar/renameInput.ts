// 帯の中でその場で名前を変える入力欄のキー。Enter で決め、Esc でやめる。
// かな漢字変換のキー（変換を確定する Enter・取り消す Esc を含む）は何もしない。見分け方は ime.ts の isComposingKey。

import {
  type ComposingKeyLike,
  isComposingKey,
} from "../../../features/commands/ime.ts";

export type RenameKeyAction = "submit" | "cancel";

export function renameKeyAction(e: ComposingKeyLike): RenameKeyAction | null {
  if (isComposingKey(e)) return null;
  if (e.key === "Enter") return "submit";
  if (e.key === "Escape") return "cancel";
  return null;
}
