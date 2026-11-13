// 帯の中でその場で名前を変える入力欄のキー。Enter で決め、Esc でやめる。
// かな漢字変換の途中の Enter・Esc は、変換のためのキーなので何もしない。
// macOS の WKWebView は、変換を確定する Enter の keydown が compositionend の後に来て、isComposing が false・keyCode が 229（key が Process）になることがある。これも変換中として扱う。

export type RenameKeyAction = "submit" | "cancel";

export function renameKeyAction(e: {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
}): RenameKeyAction | null {
  if (e.isComposing || e.key === "Process" || e.keyCode === 229) return null;
  if (e.key === "Enter") return "submit";
  if (e.key === "Escape") return "cancel";
  return null;
}
