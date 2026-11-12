// ツリーの行にフォーカスがあるときのキー（#13）。割り当ては shj のファイルツリー（shijimi-editor の
// core/app.go の HandleExplorerKey と README の「ファイルツリー」）に合わせる。
// DOM を使わないので node --test で確かめられる。行を動かす・メニューの操作をするのは TreeView.tsx と App.tsx。

import type { TreeMenuAction } from "./menu.ts";
import { rowAction, type RowAction, type TreeRow } from "./model.ts";

/** フォーカスを移す先。 */
export type TreeMove = "next" | "prev" | "first" | "last" | "parent";

/** キーでする操作。 */
export type TreeKeyAction =
  /** 行を押したのと同じ（フォルダの開閉・ファイルを開く） */
  | { kind: "row"; action: RowAction }
  /** ほかの行へフォーカスを移す */
  | { kind: "move"; to: TreeMove }
  /** 右クリックのメニューの項目と同じ（新規作成・名前の変更・削除・コピー） */
  | { kind: "menu"; action: TreeMenuAction }
  /** 右クリックのメニューを、この行で開く（. か Menu キー） */
  | { kind: "contextmenu" }
  /** この場所のキーの一覧を出す（?） */
  | { kind: "help" };

/** 押したキー（KeyboardEvent のうち使うところ）。 */
export interface TreeKey {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

/**
 * 行でキーを押したときの操作。割り当ての無いキーは null（ターミナルのキーや Tab をじゃましない）。
 *
 * - j k（↓ ↑）で上下、g G（Home End）で先頭・末尾へ。
 * - l（→）：閉じたフォルダは開く、ファイルは開く。h（←）：開いたフォルダは閉じる、ほかは親のフォルダへ。
 * - Enter・Space：行を押したのと同じ（フォルダの開閉・ファイルを開く）。
 * - a（n）で新しいファイル、A（N）で新しいフォルダ、r で名前の変更、d（Delete）で削除（確認を出す）。
 * - y で相対パス、Y で絶対パス、c で名前をコピー。m で「ここへ移動」（フォルダの行だけ）。
 * - . か Menu キーで、右クリックのメニューをこの行で開く。? でこの場所のキーの一覧。
 *
 * Ctrl・Cmd・Alt を押しながらのキーは使わない（窓全体のショートカットに残す）。
 */
export function treeKey(
  row: Pick<TreeRow, "dir" | "expanded" | "truncated">,
  e: TreeKey,
): TreeKeyAction | null {
  if (row.truncated || e.isComposing) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const move = (to: TreeMove): TreeKeyAction => ({ kind: "move", to });
  const menu = (action: TreeMenuAction): TreeKeyAction => ({
    kind: "menu",
    action,
  });
  switch (e.key) {
    case "j":
    case "ArrowDown":
      return move("next");
    case "k":
    case "ArrowUp":
      return move("prev");
    case "g":
    case "Home":
      return move("first");
    case "G":
    case "End":
      return move("last");
    case "l":
    case "ArrowRight":
      if (!row.dir) return { kind: "row", action: "open" };
      return row.expanded ? null : { kind: "row", action: "toggle" };
    case "h":
    case "ArrowLeft":
      return row.dir && row.expanded
        ? { kind: "row", action: "toggle" }
        : move("parent");
    case "a":
    case "n":
      return menu("new-file");
    case "A":
    case "N":
      return menu("new-dir");
    case "r":
      return menu("rename");
    case "d":
    case "Delete":
      return menu("delete");
    case "y":
      return menu("copy-relative");
    case "Y":
      return menu("copy-absolute");
    case "c":
      return menu("copy-name");
    case "m":
      return row.dir ? menu("cd") : null;
    case ".":
    case "ContextMenu":
      return { kind: "contextmenu" };
    case "?":
      return { kind: "help" };
  }
  const a = rowAction(row, e.key);
  return a ? { kind: "row", action: a } : null;
}
