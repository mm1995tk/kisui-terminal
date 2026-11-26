// ブラウザのタブの窓（リーダーの `a`。BrowserWindow.tsx。#459）の中のキー。
// 画面の仕組み（Solid）に依らないので、node --test で確かめる。決まりは docs/key-design.md。

import {
  BROWSER_WINDOW_ORDER,
  type BrowserOp,
  type BrowserWindowRow,
} from "../../../features/browser/window.ts";
import { isComposingKey } from "../../../features/commands/ime.ts";
import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import {
  placeItem,
  type FooterRow,
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

/** 字 → 操作。字は窓の行の字（features/browser/window.ts の BROWSER_WINDOW_ORDER）から作り、戻る・進むに矢印を足す（URL バーのボタンと同じ向き）。 */
const OPS: Readonly<Record<string, BrowserOp>> = {
  ...Object.fromEntries(BROWSER_WINDOW_ORDER.map((r) => [r.key, r.op])),
  ArrowLeft: "back",
  ArrowRight: "forward",
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
 * 窓の下の段（共通フッタ）に出す、今効く操作。「移動」と「このページ」の 2 行（ほかの窓の「選んでいるタブ」「この DB のタブ」と同じ形）。
 * 今できない行（窓の行で薄くなっているもの。why がある）は出さない。どの窓でも同じ意味のキー（j k・Enter・Esc・`?`）は出さない
 * （h l は、この窓では戻る・進むなので出す）。キーと probes は `?` の一覧の表（placeKeys.ts の browserWindow）から引く（placeItem）。
 * 操作の名前は短い英語（`browserWindow.keys.<op>`。窓の行の名前はリーダーの browser.* と同じで長い）。browserWindowKey.test.ts が、出す操作を判定が受けることと、
 * 表の操作がどれも、どこかの状態で下の段に出ることを確かめる。
 */
export function browserWindowFooter(
  rows: readonly BrowserWindowRow[],
): FooterRow[] {
  const items = (ops: readonly BrowserOp[]) =>
    rows
      .filter((r) => ops.includes(r.op) && !r.why)
      .map((r) =>
        placeItem(
          "browserWindow",
          FOOTER_KEYS[r.op],
          T(`browserWindow.keys.${r.op}`),
          [r.key],
        ),
      );
  return [
    {
      title: T("browserWindow.foot.nav"),
      items: items(["back", "forward", "reload", "stop", "url"]),
    },
    {
      title: T("browserWindow.foot.page"),
      items: items([
        "copyUrl",
        "external",
        "login",
        "find",
        "bookmark",
        "bookmarks",
        "devtools",
      ]),
    },
  ];
}

/** 操作 → `?` の一覧の表（placeKeys.ts の browserWindow）の行の keys。 */
const FOOTER_KEYS: Readonly<Record<BrowserOp, string>> = {
  back: "h / ←",
  forward: "l / →",
  reload: "r",
  stop: "c",
  url: "u",
  copyUrl: "y",
  external: "e",
  login: "s",
  find: "/",
  bookmark: "b",
  bookmarks: "B",
  devtools: "i",
};
