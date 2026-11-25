// ターミナルのタブの窓（リーダーの `a`。TerminalWindow.tsx。#457）の中のキー。
// 画面の仕組み（Solid）に依らないので、node --test で確かめる。決まりは docs/key-design.md。

import { isComposingKey } from "../../../features/commands/ime.ts";
import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import {
  basicHints,
  type BasicHint,
} from "../../../features/commands/placeKeys.ts";
import type { Direction } from "../../../features/terminal/grid.ts";
import { T } from "../../../i18n/index.ts";

/** 窓の中のキーが表す動き。どれも、地図で選んでいるペインに行う。 */
export type TerminalWindowKey =
  /** 選ぶペインを、その向きの隣へ移す（隣が無ければ動かない） */
  | { kind: "select"; dir: Direction }
  /** 選んでいるペインにフォーカスを移して、窓を閉じる */
  | { kind: "focus" }
  /** 選んでいるペインを分ける（向きを待つ間のキーに替わる。splitDirKey） */
  | { kind: "split" }
  /** 選んでいるペインを、その向きの隣と入れ替える */
  | { kind: "swap"; dir: Direction }
  /** 選んでいるペインを閉じる（プライマリは閉じない） */
  | { kind: "close" }
  /** プライマリ以外のペインを隠す・戻す */
  | { kind: "zoom" }
  /** 窓を閉じて、リサイズモードに入る */
  | { kind: "resize" }
  /** この窓のキーの一覧を出す（`?`） */
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
 * 窓の中のキー（字を打つ入力欄は無いので、字をそのまま使える。Esc は ModalCard が閉じるのに使う）。
 * 選ぶ向きは、リーダーの 1 段目・ワークスペースの窓と同じ h j k l（矢印も）。入れ替えは、ワークスペースの窓の並べ替え（J K）と同じく Shift を足した H J K L。
 * 分ける（s）・閉じる（x）・隠す（z）・リサイズモード（r）の字は、もとのリーダーの「ペイン」のグループと同じ。
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
  /** 分けるのをやめる（窓は閉じない） */
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

/**
 * 窓の下の段（共通フッタ）に出す基本操作。ほかの窓と同じ順（basicHints）で返す。
 * 分ける・入れ替える・閉じる・隠す・リサイズモード（s H J K L x z r）は出さない（`?` の一覧に出す。表は placeKeys.ts の termWindow）。
 * - splitting：分ける向きを待っている間。向きと、やめる Esc だけ（`?` は効かないので出さない）
 * - empty：ペインを出せない間。閉じる Esc だけ
 */
export function terminalWindowHints(state: {
  splitting: boolean;
  empty: boolean;
}): BasicHint[] {
  if (state.empty) return [{ keys: ["Esc"], label: T("basic.close") }];
  if (state.splitting)
    return [
      { keys: ["h", "j", "k", "l"], label: T("termWindow.keys.splitDir") },
      { keys: ["Esc"], label: T("basic.cancel") },
    ];
  return basicHints({
    select: ["h", "j", "k", "l"],
    decide: T("termWindow.keys.focus"),
    end: "close",
  });
}
