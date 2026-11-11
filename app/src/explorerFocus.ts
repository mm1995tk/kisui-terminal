// shj の Space e で、サイドバーのファイルツリーにキーを向ける（explorer.focus）。戻るのは Esc。
// DOM の要素は引数で受けるので、キーの判定だけ node --test で確かめられる。

import type { KeyLike } from "./guiKeys.ts";

/** ツリーから端末へ戻るキー：修飾キーなしの Esc と、TUI と同じ Ctrl+E（かな漢字変換中は除く）。 */
export function isLeaveExplorerKey(e: KeyLike): boolean {
  if (
    e.key.toLowerCase() === "e" &&
    e.ctrlKey &&
    !e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    !e.isComposing
  )
    return true;
  return (
    e.key === "Escape" &&
    !e.ctrlKey &&
    !e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    !e.isComposing
  );
}

/** キーを向ける行：shj が出しているファイルの行、無ければ最初の行。 */
export function explorerRow(root: ParentNode | undefined): HTMLElement | null {
  if (!root) return null;
  return (
    root.querySelector<HTMLElement>('.tree-row[aria-selected="true"]') ??
    root.querySelector<HTMLElement>(".tree-row")
  );
}
