// 切り替える窓の「タブを作る」操作のキー：種類を選ぶ一覧と、ターミナルのタブを作る行（SwitcherNewTab.tsx）。画面の仕組み（Solid）に依らないので、node --test で確かめる。決まりは docs/key-design.md。
import { isComposingKey } from "../../../features/commands/ime.ts";
import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import { listStep } from "../../../features/commands/placeKeys.ts";
import { inlineKeyAction } from "../../components/inlineInputKeys.ts";

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
 */
export function newTabInputKey(e: KeyLike): NewTabInputKey | null {
  if (isComposingKey(e)) return null;
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

/** 種類を選ぶ一覧で、その種類にすぐ決める字（一覧の行の左に出す）。 */
export const NEW_TAB_KIND_KEYS: Readonly<Record<NewTabChoice, string>> = {
  terminal: "t",
  browser: "b",
  incognito: "B",
  db: "d",
};

/** 一覧に出す種類（上から）。内蔵ブラウザが無効なら、ブラウザとシークレットは出さない。 */
export function newTabKinds(browser: boolean): NewTabChoice[] {
  return browser
    ? ["terminal", "browser", "incognito", "db"]
    : ["terminal", "db"];
}

/** 種類を選ぶ一覧のキーが表す動き */
export type NewTabKindKey =
  | { kind: "move"; to: "next" | "prev" }
  /** 選んでいる行の種類に決める（Enter） */
  | { kind: "choose" }
  /** その種類に決める（行の字） */
  | { kind: "pick"; what: NewTabChoice }
  /** 一覧だけを閉じる（窓は閉じない） */
  | { kind: "cancel" };

/**
 * 種類を選ぶ一覧のキー（j k・↓ ↑・Ctrl+J / Ctrl+K・Enter・Esc と、行の字）。kinds は、いま一覧に出している種類（出していない種類の字は受けない）。
 * 変換中のキーと、Ctrl・Cmd・Alt を重ねたもの（Ctrl+J・Ctrl+K を除く）は受けない。
 */
export function newTabKindKey(
  e: KeyLike,
  kinds: readonly NewTabChoice[],
): NewTabKindKey | null {
  if (isComposingKey(e)) return null;
  const step = listStep(e);
  if (step !== 0) return { kind: "move", to: step === 1 ? "next" : "prev" };
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case "j":
    case "ArrowDown":
      return { kind: "move", to: "next" };
    case "k":
    case "ArrowUp":
      return { kind: "move", to: "prev" };
    case "Enter":
      return e.shiftKey ? null : { kind: "choose" };
    case "Escape":
      return { kind: "cancel" };
  }
  const what = kinds.find((k) => NEW_TAB_KIND_KEYS[k] === e.key);
  return what ? { kind: "pick", what } : null;
}
