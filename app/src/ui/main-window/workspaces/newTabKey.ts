// 切り替える窓の「タブを作る」行（SwitcherNewTab.tsx）のキー。画面の仕組み（Solid）に依らないので、node --test で確かめる。決まりは docs/key-design.md。
import { isComposingKey } from "../../../features/commands/ime.ts";
import type { KeyLike } from "../../../features/commands/guiKeys.ts";
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
