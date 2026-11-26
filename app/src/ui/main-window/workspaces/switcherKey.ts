// ワークスペースを切り替える窓（リーダーの `w`。WorkspaceSwitcher.tsx）の中のキー。
// 画面の仕組み（Solid）に依らないので、node --test で確かめる。決まりは docs/key-design.md。

import { isComposingKey } from "../../../features/commands/ime.ts";
import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import {
  listStep,
  placeItem,
  type FooterItem,
  type FooterRow,
} from "../../../features/commands/placeKeys.ts";
import { T } from "../../../i18n/index.ts";
import {
  kindLabel,
  NEW_TAB_KIND_KEYS,
  type NewTabChoice,
} from "./newTabKey.ts";

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

/** 窓の下の段を決める、窓の今の状態（上ほど先に見る）。 */
export type SwitcherState =
  /** タブをつかんでいる（m のあと） */
  | { mode: "hold" }
  /** 作るタブの種類を選んでいる。kinds は選べる種類 */
  | { mode: "kinds"; kinds: readonly NewTabChoice[] }
  /** 名前を打っている。newTab はターミナルのタブを作る欄か（マシンを替えられる。ほかはワークスペース・タブの名前） */
  | { mode: "typing"; newTab: boolean }
  /** ワークスペースを閉じるか確かめている（y / n） */
  | { mode: "confirm" }
  /** タブの列にキーがあり、タブを選んでいる */
  | { mode: "tab" }
  /** ワークスペースの列にキーがある。hasWs は、選んでいるワークスペースがあるか */
  | { mode: "ws"; hasWs: boolean };

/**
 * 窓の下の段（共通フッタ）に出す、今効く操作。何に効くか（ワークスペース・タブ・この窓など）で行を分ける。
 * どの窓でも同じ意味のキー（j k h l・矢印・Enter・Esc・`?`）は出さない。意味が変わる間（タブをつかんでいる間・作るタブの種類を選ぶ間の Esc）だけ出す。
 * ふだんの操作のキーと probes は `?` の一覧の表（placeKeys.ts の switcher・switcherTabs）から引く（placeItem）。
 * 作るタブの種類の項目は、押せるボタンにする（act に種類を入れる。窓が、押したら決めるように結ぶ）。
 * switcherKey.test.ts が、出す操作をその状態の判定が受けることと、表の操作がどれも、どこかの状態で下の段に出ることを確かめる。
 */
export function switcherFooter(s: SwitcherState): FooterRow[] {
  const ws = (keys: string, label: Parameters<typeof T>[0]) =>
    placeItem("switcher", keys, T(label));
  const tab = (keys: string, label: Parameters<typeof T>[0]) =>
    placeItem("switcherTabs", keys, T(label));
  switch (s.mode) {
    case "hold":
      return [
        {
          title: T("switcher.foot.hold"),
          items: [
            item(["j", "k"], "switcher.keys.holdMove", ["j", "k"]),
            item(["h", "l"], "switcher.keys.holdCols", ["h", "l"]),
            item(["Enter"], "switcher.keys.holdDrop", ["Enter"]),
            item(["Esc"], "switcher.keys.holdCancel", ["Escape"]),
          ],
        },
      ];
    case "kinds":
      return [
        {
          title: T("switcher.foot.kinds"),
          items: [
            ...s.kinds.map((k) => ({
              keys: [NEW_TAB_KIND_KEYS[k]],
              label: kindLabel(k),
              probes: [NEW_TAB_KIND_KEYS[k]],
              act: k,
            })),
            // 窓ではなく、種類を選ぶのだけをやめる（意味が変わるので出す）
            item(["Esc"], "basic.cancel", ["Escape"]),
          ],
        },
      ];
    case "typing":
      // 決める Enter・やめる Esc は、どの窓の入力欄でも同じなので出さない。ターミナルのタブを作る欄だけ、マシンを替えられる
      return [
        {
          title: T("switcher.foot.typing"),
          items: s.newTab
            ? [
                item(["Tab"], "switcher.keys.machine", ["Tab"]),
                item(["↓"], "switcher.keys.machineList", ["ArrowDown"]),
              ]
            : [],
        },
      ];
    case "confirm":
      return [
        {
          title: T("switcher.foot.ws"),
          items: [
            item(["y"], "switcher.keys.confirmYes", ["y"]),
            item(["n"], "switcher.keys.confirmNo", ["n"]),
          ],
        },
      ];
    case "tab":
      return [
        {
          title: T("switcher.foot.tab"),
          items: [
            tab("r", "switcher.keys.rename"),
            tab("x", "switcher.keys.close"),
            tab("J K", "switcher.keys.reorder"),
            tab("m", "switcher.keys.hold"),
            tab("n", "switcher.keys.newTab"),
          ],
        },
      ];
    case "ws":
      return [
        {
          title: T("switcher.foot.ws"),
          items: s.hasWs
            ? [
                ws("N", "switcher.keys.newTab"),
                ws("r", "switcher.keys.rename"),
                ws("x", "switcher.keys.close"),
                ws("J K", "switcher.keys.reorder"),
              ]
            : [],
        },
        {
          title: T("switcher.foot.window"),
          items: [ws("n", "switcher.keys.new")],
        },
      ];
  }
}

/** `?` の一覧の表に無い状態（つかんでいる間・確かめている間・入力欄）の項目。probes はその状態の判定が受けるはずのキー */
function item(
  keys: string[],
  label: Parameters<typeof T>[0],
  probes: readonly string[],
): FooterItem {
  return { keys, label: T(label), probes };
}
