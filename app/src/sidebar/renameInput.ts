// 帯の中でその場で名前を変える入力欄のキー。Enter で決め、Esc でやめる。
// かな漢字変換の途中の Enter・Esc は、変換のためのキーなので何もしない。

export type RenameKeyAction = "submit" | "cancel";

export function renameKeyAction(e: {
  key: string;
  isComposing?: boolean;
}): RenameKeyAction | null {
  if (e.isComposing) return null;
  if (e.key === "Enter") return "submit";
  if (e.key === "Escape") return "cancel";
  return null;
}
