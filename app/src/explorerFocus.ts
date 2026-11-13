// shj の Space e で、サイドバーのファイルツリーにキーを向ける（explorer.focus）。戻るのは Esc・Ctrl+E。
// DOM の要素は引数で受けるので、キーの判定だけ node --test で確かめられる。

import { isEditorKey, type KeyLike } from "./guiKeys.ts";

/** ツリーから端末へ戻るキー：修飾キーなしの Esc と、TUI と同じ Ctrl+E（かな漢字変換中は除く）。 */
export function isLeaveExplorerKey(e: KeyLike): boolean {
  if (isEditorKey(e)) return true;
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

/**
 * shj が引数なしで起動した直後の頼み（explorer.focus の start）に、今どうするか。
 * - "drop": 頼んだワークスペースにもうフォーカスが無い。頼みを捨てる
 * - "wait": ツリーにすでにキーがある（向け済み）か、ツリーの行がまだ無い（取り直し待ち）。何もしない
 * - "focus": ツリーにキーが無く、行がある。向ける（cd でツリーが捨てられて行が消えたあとも、ここに来る）
 */
export function startFocusStep(s: {
  /** 頼んだワークスペースが、今フォーカスしているワークスペースか */
  stillFocused: boolean;
  /** キーがツリー（サイドバー）の中にあるか */
  keyInTree: boolean;
  /** ツリーの行が描かれているか */
  hasRow: boolean;
}): "drop" | "wait" | "focus" {
  if (!s.stillFocused) return "drop";
  if (s.keyInTree || !s.hasRow) return "wait";
  return "focus";
}
