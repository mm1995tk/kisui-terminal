// ブックマークの一覧（BookmarkDialog.tsx）の下の段（共通フッタ）に出す、今効く操作。
// 「選んでいるブックマーク」の行に、消す（Ctrl+D）だけ。選んでいる行がブックマークのときだけ出す（フォルダや、行が無いときは見出しだけ）。
// ↓ ↑・Ctrl+J / Ctrl+K・Enter・`?`・Esc は、どの窓でも同じキーなので出さない。
// キーは `?` の一覧の表（placeKeys.ts の bookmarks）から引く（placeItem）。bookmarkFooter.test.ts が、出す操作を bookmarkKey が受けることを確かめる。
import {
  placeItem,
  type FooterRow,
} from "../../../../features/commands/placeKeys.ts";
import { T } from "../../../../i18n/index.ts";

/** 窓の下の段。bookmarkSelected は、選んでいる行がブックマークか（フォルダ・行なしは false） */
export function bookmarkDialogFooter(bookmarkSelected: boolean): FooterRow[] {
  return [
    {
      title: T("bookmarks.foot.selected"),
      items: bookmarkSelected
        ? [placeItem("bookmarks", "Ctrl+D", T("bookmarks.keys.delete"))]
        : [],
    },
  ];
}
