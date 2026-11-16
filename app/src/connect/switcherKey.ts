// ワークスペースを切り替える窓（リーダーの `w w`。WorkspaceSwitcher.tsx）の中のキー。
// 画面の仕組み（Solid）に依らないので、node --test で確かめる。決まりは docs/key-design.md。

import type { KeyLike } from "../guiKeys.ts";
import { listStep } from "../placeKeys.ts";

/** 窓の中のキーが表す動き。 */
export type SwitcherKey =
  /** 選ぶ行を動かす（端では止まる） */
  | { kind: "move"; to: "next" | "prev" }
  /** 選んでいる行のワークスペースへ移る */
  | { kind: "go" }
  /** 上から n 番目（0 から）のワークスペースへすぐ移る */
  | { kind: "nth"; index: number }
  /** 直前のワークスペースへ移る */
  | { kind: "last" }
  /** 選んでいる行のワークスペースを 1 つ下・上へ並べ替える */
  | { kind: "reorder"; dir: "up" | "down" };

/**
 * 窓の中のキー（打った文字で絞り込む入力欄は無いので、字をそのまま使える。Esc は ModalCard が取り消しに使う）。
 * マシンを選ぶ窓と同じ動かし方（j k・矢印・Ctrl+J / Ctrl+K・Enter）に、リーダーの `w` のグループと同じ 1〜9・Tab・J K を足した。
 * Alt・Cmd・Ctrl を重ねたものは受けない（Ctrl+J・Ctrl+K を除く）。
 */
export function switcherKey(e: KeyLike): SwitcherKey | null {
  if (e.isComposing) return null;
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
    case "J":
      return { kind: "reorder", dir: "down" };
    case "K":
      return { kind: "reorder", dir: "up" };
    case "Enter":
      return e.shiftKey ? null : { kind: "go" };
    case "Tab":
      return e.shiftKey ? null : { kind: "last" };
  }
  if (/^[1-9]$/.test(e.key) && !e.shiftKey)
    return { kind: "nth", index: Number(e.key) - 1 };
  return null;
}
