// サイドバーの CHANGES の行にフォーカスがあるときのキー（#45）。割り当ては TUI の CHANGES
// （shijimi-editor の core/gitdiff.go の handleChangesKey）に合わせる。
// DOM を使わないので node --test で確かめられる。行を動かす・shj に頼むのは ChangesView.tsx と App.tsx。

import type { ChangeEntry } from "./model.ts";

/** フォーカスを移す先。 */
export type ChangesMove = "next" | "prev" | "first" | "last" | "parent";

/** キーでする操作。 */
export type ChangesAction =
  /** ほかの行へフォーカスを移す */
  | { kind: "move"; to: ChangesMove }
  /** フォルダを開く・閉じる（open: 開く、close: 閉じる、toggle: 逆にする） */
  | { kind: "folder"; op: "open" | "close" | "toggle" }
  /** 変更を開く（shj.diff）。行を押したのと同じ */
  | { kind: "open" }
  /** shj の CHANGES のキー s・r・R を shj に渡す（shj.changesKey） */
  | { kind: "shj"; key: "s" | "r" | "R" }
  /** 端末にフォーカスを戻して、このキーを端末に打つ（Space メニュー・コマンド行） */
  | { kind: "terminal"; text: string }
  /** kisui のファイルエクスプローラに移る（Tab） */
  | { kind: "explorer" }
  /** 一覧を出て端末へ戻る（Esc・q） */
  | { kind: "leave" };

/** 押したキー（KeyboardEvent のうち使うところ）。 */
export interface ChangesKey {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}

/**
 * 行でキーを押したときの操作。割り当ての無いキーは null（ブラウザの既定の動きや窓のショートカットをじゃましない）。
 * Ctrl・Cmd・Alt を押しながらのキーは使わない。Tab は Shift なしだけ（Shift+Tab は既定の動き）。
 *
 * TUI の割り当て（表は Issue #45）：
 * - k ↑ / j ↓ で上下、g Home / G End で最初・最後、h ← でフォルダを閉じる（閉じていれば親へ）、l → でフォルダを開く・変更を開く、
 *   Enter・o でフォルダの開け閉め・変更を開く。
 * - s は split / unified、r・R は読み直す（shj が行う）。Space は Space メニュー、: はコマンド行（端末に打つ。Space w はその続き）。
 * - Tab でエクスプローラへ、Esc・q で端末へ戻る。
 */
export function changesKey(
  entry: Pick<ChangeEntry, "kind" | "expanded">,
  e: ChangesKey,
): ChangesAction | null {
  if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return null;
  const dir = entry.kind === "dir";
  const move = (to: ChangesMove): ChangesAction => ({ kind: "move", to });
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
    case "h":
    case "ArrowLeft":
      return dir && entry.expanded
        ? { kind: "folder", op: "close" }
        : move("parent");
    case "l":
    case "ArrowRight":
      return dir ? { kind: "folder", op: "open" } : { kind: "open" };
    case "Enter":
    case "o":
      return dir ? { kind: "folder", op: "toggle" } : { kind: "open" };
    case "s":
    case "r":
    case "R":
      return { kind: "shj", key: e.key };
    case " ":
      return { kind: "terminal", text: " " };
    case ":":
      return { kind: "terminal", text: ":" };
    case "Tab":
      return e.shiftKey ? null : { kind: "explorer" };
    case "Escape":
    case "q":
      return { kind: "leave" };
  }
  return null;
}

/**
 * TUI の CHANGES が受けるキー（handleChangesKey の case の名前。space w の w は Space メニューの続きなので入れない）。
 * TUI にキーが増えたら、ここにも足す。足すと、keys.test.ts が changesKey の割り当てを求める。
 */
export const TUI_CHANGES_KEYS: readonly string[] = [
  "up",
  "k",
  "down",
  "j",
  "home",
  "g",
  "end",
  "G",
  "h",
  "left",
  "l",
  "right",
  "enter",
  "o",
  "s",
  "r",
  "R",
  "space",
  ":",
  "tab",
  "esc",
  "q",
];

/** TUI のキーの名前を KeyboardEvent.key にする。 */
export function domKey(tuiKey: string): string {
  const names: Record<string, string> = {
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    home: "Home",
    end: "End",
    enter: "Enter",
    space: " ",
    tab: "Tab",
    esc: "Escape",
  };
  return names[tuiKey] ?? tuiKey;
}

/** 動かす先の位置。動けないとき（端・親がいない）は -1。 */
export function moveIndex(
  entries: readonly Pick<ChangeEntry, "parent" | "key">[],
  i: number,
  to: ChangesMove,
): number {
  if (entries.length === 0) return -1;
  let j = i;
  if (to === "next") j = Math.min(i + 1, entries.length - 1);
  else if (to === "prev") j = Math.max(i - 1, 0);
  else if (to === "first") j = 0;
  else if (to === "last") j = entries.length - 1;
  else {
    const p = entries[i]?.parent;
    j = p === undefined ? i : entries.findIndex((x) => x.key === p);
  }
  return j === i || j < 0 ? -1 : j;
}

/** キーを向ける行：shj が差分を出しているファイルの行、無ければ最初の行。 */
export function changesRow(root: ParentNode | undefined): HTMLElement | null {
  if (!root) return null;
  return (
    root.querySelector<HTMLElement>('.changes-row[aria-selected="true"]') ??
    root.querySelector<HTMLElement>(".changes-row")
  );
}
