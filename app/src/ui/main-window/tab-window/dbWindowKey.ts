// DB のタブの窓（リーダーの `a`。DbWindow.tsx。#458）の中のキー。
// 画面の仕組み（Solid）に依らないので、node --test で確かめる。決まりは docs/key-design.md。

import { isComposingKey } from "../../../features/commands/ime.ts";
import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import {
  basicHints,
  type BasicHint,
} from "../../../features/commands/placeKeys.ts";
import { T } from "../../../i18n/index.ts";

/** 窓の中のキーが表す動き。select・show・close・view・page・export は、一覧で選んでいる結果のタブに行う。ほかは DB のタブ全体に行う。 */
export type DbWindowKey =
  /** 選ぶ結果のタブを、1 つ下（1）・上（-1）へ動かす */
  | { kind: "select"; step: 1 | -1 }
  /** 選んでいる結果のタブを出して、窓を閉じる */
  | { kind: "show" }
  /** 選んでいる結果のタブを閉じる */
  | { kind: "close" }
  /** 選んでいる結果のタブを出し、データと Structure を切り替える */
  | { kind: "view" }
  /** 選んでいる結果のタブを出し、次・前のページを出す */
  | { kind: "page"; step: "next" | "prev" }
  /** 実行している SQL を取り消す */
  | { kind: "cancel" }
  /** 選んでいる結果のタブを出し、書き出しの窓を開く */
  | { kind: "export" }
  /** サイドバーのスキーマの木にキーを向ける */
  | { kind: "tree" }
  /** スキーマの木とテーブルの構造を読み直す */
  | { kind: "refresh" }
  /** この接続の SQL の履歴の窓を開く */
  | { kind: "history" }
  /** 権限を時間を決めて強める窓を開く */
  | { kind: "elevate" }
  /** 強めている権限を全部元に戻す */
  | { kind: "elevateEnd" }
  /** この窓のキーの一覧を出す（`?`） */
  | { kind: "help" };

/**
 * 窓の中のキー（字を打つ入力欄は無いので、字をそのまま使える。Esc は ModalCard が閉じるのに使う）。
 * 選ぶのは、ほかの窓と同じ j k（矢印も）。ほかの字は、#458 までのリーダーの `d` のグループの字を引き継ぐ（t r e h s x p P）。
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

/**
 * 窓の下の段（共通フッタ）に出す基本操作。ほかの窓と同じ順（basicHints）で返す。
 * 結果のタブとタブ全体への操作（x s f b c e t r h p P）は出さない（`?` の一覧に出す。表は placeKeys.ts の dbWindow）。
 * - empty：結果のタブが無い間。選ぶ・Enter は効かないので、`?` と閉じる Esc だけ
 */
export function dbWindowHints(state: { empty: boolean }): BasicHint[] {
  if (state.empty)
    return [
      { keys: ["?"], label: T("basic.help") },
      { keys: ["Esc"], label: T("basic.close") },
    ];
  return basicHints({ decide: T("dbWindow.keys.show"), end: "close" });
}
