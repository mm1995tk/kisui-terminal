// ワークスペースを切り替える窓（リーダーの `w`。WorkspaceSwitcher.tsx）の中のキー。
// 画面の仕組み（Solid）に依らないので、node --test で確かめる。決まりは docs/key-design.md。

import { isComposingKey } from "../../../features/commands/ime.ts";
import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import {
  basicHints,
  listStep,
  type BasicHint,
} from "../../../features/commands/placeKeys.ts";
import { T } from "../../../i18n/index.ts";

/** 窓の中のキーが表す動き。 */
export type SwitcherKey =
  /** キーが効く列の中で、選ぶ行を動かす（端では止まる） */
  | { kind: "move"; to: "next" | "prev" }
  /** キーが効く列を移る（左がワークスペース、右がそのタブ） */
  | { kind: "col"; to: "ws" | "tab" }
  /** 選んでいる行を開いて閉じる（ワークスペースの列ならそのワークスペースへ移り、タブの列ならそのタブを出す） */
  | { kind: "go" }
  /** 選んでいる行（ワークスペースかタブ）を 1 つ下・上へ並べ替える */
  | { kind: "reorder"; dir: "up" | "down" }
  /** 作る（ワークスペースの列ならワークスペース、タブの列ならタブ。タブは、種類を選ぶ一覧を出す） */
  | { kind: "new" }
  /** 選んでいるワークスペースにタブを作る（どちらの列でも。種類を選ぶ一覧を出す。タブの無いワークスペースでも使える） */
  | { kind: "newTab" }
  /** 選んでいる行（ワークスペースかタブ）の名前を変える */
  | { kind: "rename" }
  /** 選んでいる行を閉じる（ワークスペースは先に y / n で確かめる。タブは確かめずに閉じる） */
  | { kind: "close" }
  /** 選んでいるタブをつかむ（タブの列だけ。別のワークスペースへ移すために、つかんでいる間のキーに替わる。switcherHold.ts） */
  | { kind: "hold" }
  /** この窓のキーの一覧を出す（`?`） */
  | { kind: "help" };

/**
 * 窓の中のキー（打った文字で絞り込む入力欄は無いので、字をそのまま使える。Esc は ModalCard が取り消しに使う）。
 * マシンを選ぶ窓と同じ動かし方（j k・矢印・Ctrl+J / Ctrl+K・Enter）に、列を移る（h l・矢印の左右）と、並べ替え（J K）と、ワークスペースを作る・名前を変える・閉じる（n r x）と、タブを作る（N）を足した。
 * 並べ替え・名前を変える・閉じる・作る（n）は、効いている列の選んでいる行（ワークスペースかタブ）に効く（n は、ワークスペースの列ならワークスペース、タブの列ならタブを作る）。N は、どちらの列でも、選んでいるワークスペースにタブを作る。タブを作るときは、種類を選ぶ一覧を出す（キーは newTabKey.ts）。ワークスペースを閉じるときだけ y / n で確かめる（タブは確かめずに閉じる）。
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
    case "N":
      return { kind: "newTab" };
    case "r":
      return { kind: "rename" };
    case "x":
      return { kind: "close" };
    case "m":
      return { kind: "hold" };
    case "?":
      return { kind: "help" };
  }
  return null;
}

/** タブをつかんでいる間のキーが表す動き。 */
export type HoldKey =
  /** ワークスペースの列なら移す先のワークスペースを、タブの列ならつかんだタブの入る位置を、1 つ動かす（端では止まる） */
  | { kind: "move"; to: "next" | "prev" }
  /** キーが効く列を移る（入る位置は変えない） */
  | { kind: "col"; to: "ws" | "tab" }
  /** 落とす（Enter・m） */
  | { kind: "drop" }
  /** やめて、つかんだときの所に戻す（窓は閉じない） */
  | { kind: "cancel" };

/**
 * タブをつかんでいる間（m のあと）のキー。動かす（j k・矢印・Ctrl+J / Ctrl+K）・列を移る（h l・矢印の左右）・落とす（Enter・m）・やめる（Esc）だけで、ほかは受けない。
 * Alt・Cmd・Ctrl を重ねたもの（Ctrl+J・Ctrl+K を除く）と変換中のキーも受けない。
 */
export function holdKey(e: KeyLike): HoldKey | null {
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
    case "Enter":
      return e.shiftKey ? null : { kind: "drop" };
    case "m":
      return { kind: "drop" };
    case "Escape":
      return { kind: "cancel" };
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

/**
 * 窓の下の段（共通フッタ）に出す基本操作。いまキーが効いている列（col）で効くものだけを、ほかの窓と同じ順（basicHints）で返す。
 * 作る・名前を変える・閉じる・並べ替える・タブをつかむ（n N r x J K m）は出さない（`?` の一覧に出す。表は placeKeys.ts の switcher・switcherTabs）。
 * hasTabs は、選んでいるワークスペースにタブがあるか（無ければ、左の列から `l` でタブの列には移れないので出さない）。
 */
export function switcherHints(
  col: "ws" | "tab",
  hasTabs: boolean,
): BasicHint[] {
  if (col === "tab")
    return basicHints({
      move: [{ keys: ["h"], label: T("switcher.keys.toWorkspaces") }],
      decide: T("switcher.keys.showTab"),
      end: "close",
    });
  return basicHints({
    move: hasTabs ? [{ keys: ["l"], label: T("switcher.keys.toTabs") }] : [],
    decide: T("switcher.keys.go"),
    end: "close",
  });
}

/**
 * タブの種類を選ぶ一覧を出している間に、窓の下に出すキーの説明（一覧のキーだけ。種類の字は一覧の行に出す。`?` は効かないので出さない）。
 */
export function newTabKindHints(): BasicHint[] {
  return basicHints({ decide: T("basic.decide"), help: false, end: "cancel" });
}

/**
 * タブをつかんでいる間に、窓の下に出すキーの説明（つかんでいる間のキーだけ。どれも基本操作で、`?` は効かないので出さない）。
 * 並びはほかの窓と同じ（選ぶ → 移る → 決める → やめる）。
 */
export function holdHints(): BasicHint[] {
  return [
    { keys: ["j", "k"], label: T("switcher.keys.holdMove") },
    { keys: ["h", "l"], label: T("switcher.keys.holdCols") },
    { keys: ["Enter"], label: T("switcher.keys.holdDrop") },
    { keys: ["Esc"], label: T("basic.cancel") },
  ];
}
