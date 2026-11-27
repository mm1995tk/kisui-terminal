// ブックマークの一覧（BookmarkDialog.tsx）の Key footer（共通フッタ）に出す、今効く操作。
// 「選んでいるブックマーク」の行に、消す（Ctrl+D）だけ。選んでいる行がブックマークのときだけ出す（フォルダや、行が無いときは見出しだけ）。
// ↓ ↑・Ctrl+J / Ctrl+K・Enter・`?`・Esc は、どの Dialog でも同じキーなので出さない。
// キーは `?` の一覧の表（placeKeys.ts の bookmarks）から引く（placeItem）。bookmarkFooter.test.ts が、出す操作を bookmarkKey が受けることを確かめる。
import {
  placeItem,
  type FooterRow,
} from "../../../../features/commands/placeKeys.ts";
import type { BookmarkRow } from "../../../../features/browser/bookmarkTree.ts";
import { T } from "../../../../i18n/index.ts";

/** 選んでいる行を消せるか。消せるのは kisui-terminal 自身のブックマークだけ（Chrome のブックマーク・フォルダ・行が無いときは消せない） */
export function canDeleteRow(row: BookmarkRow | undefined): boolean {
  return row?.kind === "bookmark" && row.bookmark.source !== "chrome";
}

/** Dialog の Key footer。deletable は、選んでいる行を消せるか（canDeleteRow）。消せなければ見出しだけ */
export function bookmarkDialogFooter(deletable: boolean): FooterRow[] {
  return [
    {
      title: T("bookmarks.foot.selected"),
      items: deletable
        ? [placeItem("bookmarks", "Ctrl+D", T("bookmarks.keys.delete"))]
        : [],
    },
  ];
}
