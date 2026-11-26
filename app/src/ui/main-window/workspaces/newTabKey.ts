// 切り替える窓の「タブを作る」操作のキー：種類を選ぶ一覧と、ターミナルのタブを作る行（SwitcherNewTab.tsx）。画面の仕組み（Solid）に依らないので、node --test で確かめる。決まりは docs/key-design.md。
import { isComposingKey } from "../../../features/commands/ime.ts";
import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import { inlineKeyAction } from "../../components/inlineInputKeys.ts";
import { T } from "../../../i18n/index.ts";

/** 名前の入力欄のキーが表す動き */
export type NewTabInputKey =
  /** 次・前のマシンに替える（Tab・Shift+Tab） */
  | { kind: "machine"; to: "next" | "prev" }
  /** マシンの一覧を開く（↓） */
  | { kind: "openList" }
  /** その名前・そのマシンで作る（Enter） */
  | { kind: "submit" }
  /** 作らずにやめる（Esc） */
  | { kind: "cancel" };

/** マシンの一覧のキーが表す動き */
export type NewTabListKey =
  | { kind: "move"; to: "next" | "prev" }
  /** 選んでいるマシンに決めて、名前の入力欄に戻る */
  | { kind: "choose" }
  /** 一覧だけを閉じて、名前の入力欄に戻る */
  | { kind: "close" };

/**
 * 名前の入力欄のキー。変換中のキー（変換を確定する Enter・取り消す Esc・変換候補を選ぶ Tab と ↓ を含む）は何もしない。
 * Ctrl・Cmd・Alt を重ねたものは受けない（Tab は Shift だけ重ねてよい）。
 * 押したままのリピートの Enter では決めない（行を出した Enter（種類の一覧・マシンのダイアログ）を押したままにして、空の名前で作らないように）。
 */
export function newTabInputKey(e: KeyLike): NewTabInputKey | null {
  if (isComposingKey(e)) return null;
  if (e.key === "Enter" && e.repeat) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === "Tab")
    return { kind: "machine", to: e.shiftKey ? "prev" : "next" };
  if (e.key === "ArrowDown") return { kind: "openList" };
  const a = inlineKeyAction(e);
  return a ? { kind: a } : null;
}

/** マシンの一覧のキー（j k・↓ ↑・Enter・Esc）。変換中のキーと、Ctrl・Cmd・Alt を重ねたものは受けない。 */
export function newTabListKey(e: KeyLike): NewTabListKey | null {
  if (isComposingKey(e)) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case "j":
    case "ArrowDown":
      return { kind: "move", to: "next" };
    case "k":
    case "ArrowUp":
      return { kind: "move", to: "prev" };
    case "Enter":
      return { kind: "choose" };
    case "Escape":
      return { kind: "close" };
  }
  return null;
}

/** 切り替える窓から作れるタブの種類（種類を選ぶ一覧の行。#456）。incognito は、シークレットのブラウザのタブ */
export type NewTabChoice = "terminal" | "browser" | "incognito" | "db";

/** 作るタブの種類に決める字（窓の下の段のボタンに出す）。 */
export const NEW_TAB_KIND_KEYS: Readonly<Record<NewTabChoice, string>> = {
  terminal: "t",
  browser: "b",
  incognito: "B",
  db: "d",
};

/** 種類の名前（サイドバーの「+」のメニューと同じ言葉。操作の名前なので、日本語の窓でも英語）。 */
export function kindLabel(kind: NewTabChoice): string {
  switch (kind) {
    case "terminal":
      return T("sidebar.addTerminal");
    case "browser":
      return T("sidebar.addBrowser");
    case "incognito":
      return T("switcher.newTab.incognito");
    case "db":
      return T("sidebar.addDb");
  }
}

/** 一覧に出す種類（上から）。内蔵ブラウザが無効なら、ブラウザとシークレットは出さない。 */
export function newTabKinds(browser: boolean): NewTabChoice[] {
  return browser
    ? ["terminal", "browser", "incognito", "db"]
    : ["terminal", "db"];
}

/** 作るタブの種類を選んでいる間のキーが表す動き */
export type NewTabKindKey =
  /** その種類に決める（種類の字） */
  | { kind: "pick"; what: NewTabChoice }
  /** 種類を選ぶのだけをやめる（窓は閉じない） */
  | { kind: "cancel" };

/**
 * 作るタブの種類を選んでいる間のキー（種類の字と Esc。種類は窓の下の段にボタンで出す。#487）。kinds は、いま選べる種類（選べない種類の字は受けない）。
 * 選ぶ行を出さないので、j k・Enter では選ばない。変換中のキーと、Ctrl・Cmd・Alt を重ねたものは受けない。
 */
export function newTabKindKey(
  e: KeyLike,
  kinds: readonly NewTabChoice[],
): NewTabKindKey | null {
  if (isComposingKey(e)) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === "Escape") return { kind: "cancel" };
  const what = kinds.find((k) => NEW_TAB_KIND_KEYS[k] === e.key);
  return what ? { kind: "pick", what } : null;
}
