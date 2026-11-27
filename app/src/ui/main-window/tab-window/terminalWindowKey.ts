// ターミナルのタブの Dialog（リーダーの `a`。TerminalWindow.tsx。#457）の中のキー。
// 画面の仕組み（Solid）に依らないので、node --test で確かめる。決まりは docs/key-design.md。

import { isComposingKey } from "../../../features/commands/ime.ts";
import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import {
  placeItem,
  type FooterRow,
} from "../../../features/commands/placeKeys.ts";
import type { Direction } from "../../../features/terminal/grid.ts";
import { T } from "../../../i18n/index.ts";

/** Dialog の中のキーが表す動き。どれも、地図で選んでいるペインに行う。 */
export type TerminalWindowKey =
  /** 選ぶペインを、その向きの隣へ移す（隣が無ければ動かない） */
  | { kind: "select"; dir: Direction }
  /** 選んでいるペインにフォーカスを移して、Dialog を閉じる */
  | { kind: "focus" }
  /** 選んでいるペインを分ける（向きを待つ間のキーに替わる。splitDirKey） */
  | { kind: "split" }
  /** 選んでいるペインを、その向きの隣と入れ替える */
  | { kind: "swap"; dir: Direction }
  /** 選んでいるペインを閉じる（プライマリは閉じない） */
  | { kind: "close" }
  /** プライマリ以外のペインを隠す・戻す */
  | { kind: "zoom" }
  /** Dialog を閉じて、リサイズモードに入る */
  | { kind: "resize" }
  /** この Dialog のキーの一覧を出す（`?`） */
  | { kind: "help" };

/** 向きのキー（h j k l と矢印）。向きでなければ undefined。 */
function dirOf(key: string): Direction | undefined {
  switch (key) {
    case "h":
    case "ArrowLeft":
      return "left";
    case "j":
    case "ArrowDown":
      return "down";
    case "k":
    case "ArrowUp":
      return "up";
    case "l":
    case "ArrowRight":
      return "right";
  }
  return undefined;
}

const SWAP: Readonly<Record<string, Direction>> = {
  H: "left",
  J: "down",
  K: "up",
  L: "right",
};

/**
 * Dialog の中のキー（字を打つ入力欄は無いので、字をそのまま使える。Esc は ModalCard が閉じるのに使う）。
 * 選ぶ向きは、リーダーの 1 段目・Workspace switcher と同じ h j k l（矢印も）。入れ替えは、Workspace switcher の並べ替え（J K）と同じく Shift を足した H J K L。
 * Alt・Cmd・Ctrl を重ねたものと、変換中のキーは受けない。
 */
export function terminalWindowKey(e: KeyLike): TerminalWindowKey | null {
  if (isComposingKey(e)) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const swap = SWAP[e.key];
  if (swap) return { kind: "swap", dir: swap };
  const dir = dirOf(e.key);
  if (dir) return e.shiftKey ? null : { kind: "select", dir };
  switch (e.key) {
    case "Enter":
      return e.shiftKey ? null : { kind: "focus" };
    case "s":
      return { kind: "split" };
    case "x":
      return { kind: "close" };
    case "z":
      return { kind: "zoom" };
    case "r":
      return { kind: "resize" };
    case "?":
      return { kind: "help" };
  }
  return null;
}

/** 分ける向きを待つ間（`s` のあと）のキーが表す動き。 */
export type SplitDirKey =
  /** その向きに分ける */
  | { kind: "dir"; dir: Direction }
  /** 分けるのをやめる（Dialog は閉じない） */
  | { kind: "cancel" };

/**
 * 分ける向きを待つ間のキー。向き（h j k l・矢印）と、やめる（Esc）だけで、ほかは受けない。
 * Alt・Cmd・Ctrl・Shift を重ねたものと、変換中のキー（変換を取り消す Esc を含む）も受けない。
 */
export function splitDirKey(e: KeyLike): SplitDirKey | null {
  if (isComposingKey(e)) return null;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  if (e.key === "Escape") return { kind: "cancel" };
  const dir = dirOf(e.key);
  return dir ? { kind: "dir", dir } : null;
}

/** Dialog の Key footer を決める、Dialog の今の状態。 */
export interface TerminalWindowState {
  /** 分ける向きを待っているか（`s` のあと） */
  splitting: boolean;
  /** ペインを出せない間か */
  empty: boolean;
  /** 選んでいるペインがプライマリか（プライマリは閉じられない） */
  primary: boolean;
  /** 選んでいるペインに、入れ替えられる隣があるか */
  swappable: boolean;
  /** プライマリ以外のペインを隠す・戻すことができるか */
  canZoom: boolean;
}

/**
 * Dialog の Key footer（共通フッタ）に出す、今効く操作。「選んでいるペイン」と「このタブ」の 2 行。
 * 効かない操作は出さない。どの Dialog でも同じ意味のキー（h j k l・Enter・Esc・`?`）は出さない（意味が変わる、分ける向きを待つ間を除く）。
 * - splitting：分ける向きを待っている間。向きと、やめる Esc だけ（`?` は効かないので出さない）
 * - empty：ペインを出せない間。効く操作は無いので、見出しだけ
 * ふだんの操作のキーと probes は `?` の一覧の表（placeKeys.ts の termWindow）から引く（placeItem）。terminalWindowKey.test.ts が、出す操作を判定が受けることと、
 * 表の操作がどれも、どこかの状態で Key footer に出ることを確かめる。
 */
export function terminalWindowFooter(s: TerminalWindowState): FooterRow[] {
  if (!s.empty && s.splitting)
    return [
      {
        title: T("termWindow.foot.split"),
        items: [
          {
            keys: ["h", "j", "k", "l"],
            label: T("termWindow.keys.splitDir"),
            probes: ["h", "j", "k", "l"],
          },
          {
            keys: ["Esc"],
            label: T("termWindow.keys.splitCancel"),
            probes: ["Escape"],
          },
        ],
      },
    ];
  const item = (keys: string, label: Parameters<typeof T>[0]) =>
    placeItem("termWindow", keys, T(label));
  const on = <V>(cond: boolean, v: V): V[] => (cond ? [v] : []);
  const live = !s.empty;
  return [
    {
      title: T("termWindow.foot.pane"),
      items: [
        ...on(live, item("s", "termWindow.keys.split")),
        ...on(live && s.swappable, item("H J K L", "termWindow.keys.swap")),
        ...on(live && !s.primary, item("x", "termWindow.keys.close")),
      ],
    },
    {
      title: T("termWindow.foot.tab"),
      items: [
        ...on(live && s.canZoom, item("z", "termWindow.keys.zoom")),
        ...on(live, item("r", "termWindow.keys.resize")),
      ],
    },
  ];
}
