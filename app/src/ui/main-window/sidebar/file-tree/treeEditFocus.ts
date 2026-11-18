// ツリーのその場の入力欄（新しいファイル・フォルダ・名前の変更）を閉じたあと、キーをツリーの行に戻す。TreeView.tsx が使う。
import { createEffect, on } from "solid-js";

import {
  newEntryPath,
  renamedPath,
} from "../../../../features/file-tree/menu.ts";
import {
  parentOf,
  type TreeRow,
} from "../../../../features/file-tree/model.ts";
import type { TreeEditView } from "./TreeView.tsx";

/** 入力欄で決めた・やめたことを伝える口。TreeView は、入力欄から届いた値をここへ渡してから、呼んだ側へ渡す。 */
export interface TreeEditFocus {
  /** 入力欄で Enter を押した（値はルートからの相対パス） */
  submitted: (value: string) => void;
  /** 入力欄を閉じた（byKey は Esc を押したとき。フォーカスが外れたときは false） */
  cancelled: (byKey: boolean) => void;
}

/**
 * 入力欄を閉じたあとのフォーカスの行き先を決める。
 * - 決めて入力欄が消えたら、できた行・名前を変えた行へ。その行がまだツリーに出ていなければ（一覧を読み直している間）、
 *   入力欄を開いた行（無ければその親）に置き、ツリーの行が変わるたびにできた行を探す（見つかるか、キーがツリーの外へ出るか、別の入力欄を開くまで）。
 * - Esc でやめたら、入力欄を開いた行へ。フォーカスが外れてやめたときは、移った先のまま。
 */
export function createTreeEditFocus(
  tree: () => HTMLElement | undefined,
  edit: () => TreeEditView | undefined,
  rows: () => readonly TreeRow[],
): TreeEditFocus {
  /** path の行にフォーカスを移す。行が無ければ false */
  const focusRow = (path: string): boolean => {
    const el = tree()?.querySelector<HTMLElement>(
      `.tree-row[data-path="${CSS.escape(path)}"]`,
    );
    el?.focus();
    return !!el;
  };
  let submitted: { to: string | null; from: string } | undefined;
  /** まだツリーに出ていない、できた行・名前を変えた行の path */
  let waiting: string | undefined;
  createEffect(
    on(edit, (e) => {
      if (e) {
        // 別の入力欄を開いたら、前に決めた行はもう待たない
        waiting = undefined;
        return;
      }
      const s = submitted;
      if (!s) return;
      submitted = undefined;
      queueMicrotask(() => {
        if (s.to !== null && focusRow(s.to)) return;
        if (!focusRow(s.from)) focusRow(parentOf(s.from));
        if (s.to !== null) waiting = s.to;
      });
    }),
  );
  createEffect(
    on(
      rows,
      () => {
        if (waiting === undefined) return;
        queueMicrotask(() => {
          const to = waiting;
          if (to === undefined) return;
          const at = document.activeElement;
          // そのあいだにキーをツリーの外へ動かしていたら、もう待たない
          if (!(at instanceof HTMLElement && tree()?.contains(at))) {
            waiting = undefined;
            return;
          }
          if (focusRow(to)) waiting = undefined;
        });
      },
      { defer: true },
    ),
  );
  return {
    submitted: (value) => {
      const e = edit();
      if (!e) return;
      const to =
        e.kind === "rename"
          ? (renamedPath(e.path, value) ?? e.path)
          : newEntryPath(value, e.kind === "new-file" ? "file" : "dir");
      submitted = { to, from: e.path };
    },
    cancelled: (byKey) => {
      const path = edit()?.path;
      submitted = undefined;
      waiting = undefined;
      if (byKey && path !== undefined) queueMicrotask(() => focusRow(path));
    },
  };
}
