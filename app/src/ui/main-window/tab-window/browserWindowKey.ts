// ブラウザのタブの窓（リーダーの `a`。BrowserWindow.tsx。#459）の中のキー。
// 画面の仕組み（Solid）に依らないので、node --test で確かめる。決まりは docs/key-design.md。

import type { BrowserOp } from "../../../features/browser/window.ts";
import { isComposingKey } from "../../../features/commands/ime.ts";
import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import {
  basicHints,
  type BasicHint,
} from "../../../features/commands/placeKeys.ts";
import { T } from "../../../i18n/index.ts";

/** 窓の中のキーが表す動き。 */
export type BrowserWindowKey =
  /** 選ぶ行を、1 つ下（1）・上（-1）へ動かす（今できない行は飛ばす） */
  | { kind: "select"; step: 1 | -1 }
  /** 選んでいる行の操作を行う */
  | { kind: "run" }
  /** 字で、その操作を行う */
  | { kind: "op"; op: BrowserOp }
  /** この窓のキーの一覧を出す（`?`） */
  | { kind: "help" };

/** 字 → 操作。字は、#459 までのリーダーの `o` のグループの字を引き継ぐ（窓の行の字。features/browser/window.ts と同じ）。 */
const OPS: Readonly<Record<string, BrowserOp>> = {
  h: "back",
  ArrowLeft: "back",
  l: "forward",
  ArrowRight: "forward",
  r: "reload",
  c: "stop",
  u: "url",
  y: "copyUrl",
  e: "external",
  s: "login",
  "/": "find",
  b: "bookmark",
  B: "bookmarks",
  i: "devtools",
};

/**
 * 窓の中のキー（字を打つ入力欄は無いので、字をそのまま使える。Esc は ModalCard が閉じるのに使う）。
 * 選ぶのは、ほかの窓と同じ j k（矢印も）。戻る・進むは h l（← → も。URL バーのボタンと同じ向き）。
 * Alt・Cmd・Ctrl を重ねたものと、変換中のキーは受けない。Shift は、字で見分ける（B と ?）。
 */
export function browserWindowKey(e: KeyLike): BrowserWindowKey | null {
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
      return e.shiftKey ? null : { kind: "run" };
    case "?":
      return { kind: "help" };
  }
  const op = Object.hasOwn(OPS, e.key) ? OPS[e.key] : undefined;
  if (!op) return null;
  // 矢印は Shift を重ねたら受けない（字は、Shift で大文字になった字そのもので見分ける）
  if (e.shiftKey && e.key.startsWith("Arrow")) return null;
  return { kind: "op", op };
}

/**
 * 窓の下の段（共通フッタ）に出す基本操作。ほかの窓と同じ順（basicHints）で返す。
 * 操作の字は行に出ているので、ここには並べない（`?` の一覧にも出す。表は placeKeys.ts の browserWindow）。
 */
export function browserWindowHints(): BasicHint[] {
  return basicHints({ decide: T("browserWindow.keys.run"), end: "close" });
}
