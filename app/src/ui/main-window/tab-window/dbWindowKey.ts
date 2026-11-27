// DB のタブの Dialog（リーダーの `a`。DbWindow.tsx。#458）の中のキー。
// 画面の仕組み（Solid）に依らないので、node --test で確かめる。決まりは docs/key-design.md。

import { isComposingKey } from "../../../features/commands/ime.ts";
import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import {
  placeItem,
  type FooterRow,
} from "../../../features/commands/placeKeys.ts";
import { T } from "../../../i18n/index.ts";

/** Dialog の中のキーが表す動き。select・show・close・view・page・export は、一覧で選んでいる結果のタブに行う。ほかは DB のタブ全体に行う。 */
export type DbWindowKey =
  /** 選ぶ結果のタブを、1 つ下（1）・上（-1）へ動かす */
  | { kind: "select"; step: 1 | -1 }
  /** 選んでいる結果のタブを出して、Dialog を閉じる */
  | { kind: "show" }
  /** 選んでいる結果のタブを閉じる */
  | { kind: "close" }
  /** 選んでいる結果のタブを出し、データと Structure を切り替える */
  | { kind: "view" }
  /** 選んでいる結果のタブを出し、次・前のページを出す */
  | { kind: "page"; step: "next" | "prev" }
  /** 実行している SQL を取り消す */
  | { kind: "cancel" }
  /** 選んでいる結果のタブを出し、書き出しの Dialog を開く */
  | { kind: "export" }
  /** サイドバーのスキーマの木にキーを向ける */
  | { kind: "tree" }
  /** スキーマの木とテーブルの構造を読み直す */
  | { kind: "refresh" }
  /** この接続の SQL の履歴の Dialog を開く */
  | { kind: "history" }
  /** 権限を時間を決めて強める Dialog を開く */
  | { kind: "elevate" }
  /** 強めている権限を全部元に戻す */
  | { kind: "elevateEnd" }
  /** この Dialog のキーの一覧を出す（`?`） */
  | { kind: "help" };

/**
 * Dialog の中のキー（字を打つ入力欄は無いので、字をそのまま使える。Esc は ModalCard が閉じるのに使う）。
 * 選ぶのは、ほかの Dialog と同じ j k（矢印も）。ほかの字は、#458 までのリーダーの `d` のグループの字を引き継ぐ（t r e h s x p P）。
 * ページは、j k が選ぶになったので f b（forward・back。less・vim のページ送りの字）。
 * Alt・Cmd・Ctrl を重ねたものと、変換中のキーは受けない。Shift は、字で見分ける（P と ?）。
 */
export function dbWindowKey(e: KeyLike): DbWindowKey | null {
  if (isComposingKey(e)) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case "j":
    case "ArrowDown":
      return e.shiftKey ? null : { kind: "select", step: 1 };
    case "k":
    case "ArrowUp":
      return e.shiftKey ? null : { kind: "select", step: -1 };
    case "Enter":
      return e.shiftKey ? null : { kind: "show" };
    case "x":
      return { kind: "close" };
    case "s":
      return { kind: "view" };
    case "f":
      return { kind: "page", step: "next" };
    case "b":
      return { kind: "page", step: "prev" };
    case "c":
      return { kind: "cancel" };
    case "e":
      return { kind: "export" };
    case "t":
      return { kind: "tree" };
    case "r":
      return { kind: "refresh" };
    case "h":
      return { kind: "history" };
    case "p":
      return { kind: "elevate" };
    case "P":
      return { kind: "elevateEnd" };
    case "?":
      return { kind: "help" };
  }
  return null;
}

/** Dialog の Key footer を決める、Dialog の今の状態。 */
export interface DbWindowState {
  /** 結果のタブを選んでいるか（結果のタブが 1 つも無ければ false） */
  selected: boolean;
  /** 選んでいる結果のタブが、木で選んだテーブルのものか（データと Structure を切り替えられる） */
  table: boolean;
  /** 選んでいる結果のタブの SQL が終わって結果があるか（ページを送れる） */
  done: boolean;
  /** 選んでいる結果のタブに、書き出せる行があるか */
  exportable: boolean;
  /** SQL を実行している最中か（取り消せる） */
  running: boolean;
  /** 強めている権限があるか（元に戻せる） */
  elevated: boolean;
}

/**
 * Dialog の Key footer（共通フッタ）に出す、今効く操作。「選んでいるタブ」と「この DB のタブ」の 2 行。
 * 効かない操作は出さない。どの Dialog でも同じ意味のキー（j k・Enter・Esc・`?`）は出さない（h は、この Dialog では履歴なので出す）。
 * キーと probes は `?` の一覧の表（placeKeys.ts の dbWindow）から引く（placeItem）。dbWindowKey.test.ts が、出す操作を判定が受けることと、
 * 表の操作がどれも、どこかの状態で Key footer に出ることを確かめる。
 */
export function dbWindowFooter(s: DbWindowState): FooterRow[] {
  const item = (keys: string, label: Parameters<typeof T>[0]) =>
    placeItem("dbWindow", keys, T(label));
  const on = <V>(cond: boolean, v: V): V[] => (cond ? [v] : []);
  return [
    {
      title: T("dbWindow.foot.selected"),
      items: [
        ...on(s.selected, item("x", "dbWindow.keys.close")),
        ...on(s.selected && s.table, item("s", "dbWindow.keys.view")),
        ...on(s.selected && s.done, item("f b", "dbWindow.keys.page")),
        ...on(s.selected && s.exportable, item("e", "dbWindow.keys.export")),
      ],
    },
    {
      title: T("dbWindow.foot.tab"),
      items: [
        ...on(s.running, item("c", "dbWindow.keys.cancel")),
        item("t", "dbWindow.keys.tree"),
        item("r", "dbWindow.keys.refresh"),
        item("h", "dbWindow.keys.history"),
        item("p", "dbWindow.keys.elevate"),
        ...on(s.elevated, item("P", "dbWindow.keys.elevateEnd")),
      ],
    },
  ];
}
