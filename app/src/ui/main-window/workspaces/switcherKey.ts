// ワークスペースを切り替える窓（リーダーの `w`。WorkspaceSwitcher.tsx）の中のキー。
// 画面の仕組み（Solid）に依らないので、node --test で確かめる。決まりは docs/key-design.md。

import { isComposingKey } from "../../../features/commands/ime.ts";
import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import { listStep } from "../../../features/commands/placeKeys.ts";

/** 窓の中のキーが表す動き。 */
export type SwitcherKey =
  /** キーが効く列の中で、選ぶ行を動かす（端では止まる） */
  | { kind: "move"; to: "next" | "prev" }
  /** キーが効く列を移る（左がワークスペース、右がそのタブ） */
  | { kind: "col"; to: "ws" | "tab" }
  /** 選んでいる行を開いて閉じる（ワークスペースの列ならそのワークスペースへ移り、タブの列ならそのタブを出す） */
  | { kind: "go" }
  /** 選んでいる行のワークスペースを 1 つ下・上へ並べ替える */
  | { kind: "reorder"; dir: "up" | "down" }
  /** ワークスペースを作る */
  | { kind: "new" }
  /** 選んでいる行のワークスペースの名前を変える */
  | { kind: "rename" }
  /** 選んでいる行のワークスペースを閉じる（先に y / n で確かめる） */
  | { kind: "close" };

/**
 * 窓の中のキー（打った文字で絞り込む入力欄は無いので、字をそのまま使える。Esc は ModalCard が取り消しに使う）。
 * マシンを選ぶ窓と同じ動かし方（j k・矢印・Ctrl+J / Ctrl+K・Enter）に、列を移る（h l・矢印の左右）と、並べ替え（J K）と、ワークスペースを作る・名前を変える・閉じる（n r x）を足した。
 * 並べ替え・作る・名前を変える・閉じるは、ワークスペースの列で効く（タブの列では、呼んだ側が何もしない）。
 * Alt・Cmd・Ctrl を重ねたものは受けない（Ctrl+J・Ctrl+K を除く）。変換中のキーも受けない。
 */
export function switcherKey(e: KeyLike): SwitcherKey | null {
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
    case "h":
    case "ArrowLeft":
      return { kind: "col", to: "ws" };
    case "l":
    case "ArrowRight":
      return { kind: "col", to: "tab" };
    case "J":
      return { kind: "reorder", dir: "down" };
    case "K":
      return { kind: "reorder", dir: "up" };
    case "Enter":
      return e.shiftKey ? null : { kind: "go" };
    case "n":
      return { kind: "new" };
    case "r":
      return { kind: "rename" };
    case "x":
      return { kind: "close" };
  }
  return null;
}

/**
 * 閉じる確認（`x`・✕ のあと）の間のキー。`y` で閉じ、`n` でやめる（Esc でやめるのは窓側）。
 * 確認の間は、ほかのキーは何もしない（null）。
 */
export function confirmKey(e: KeyLike): "yes" | "no" | null {
  if (isComposingKey(e)) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === "y") return "yes";
  if (e.key === "n") return "no";
  return null;
}
