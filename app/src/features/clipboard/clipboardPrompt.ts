import { createSignal } from "solid-js";

/**
 * 許可を求める読み取り。read は今のクリップボードを読む頼み（OSC 5522）で、mimes は頼まれた MIME の種類（そのまま見せる）。
 * history はクリップボードの履歴を読む頼み（`kisui clipboard history`。#517）。
 */
export type ReadAsk =
  | { kind: "read"; mimes: string[] }
  | {
      kind: "history";
      /** 頼んだ Pane の Terminal tab の名前（人が、頼んだ覚えがあるかを確かめられるように） */
      tab: string;
    };

/** 許可を待っている読み取りの頼み。resolve で、許す（true）か断る（false）かを答える。 */
export type ReadPrompt = ReadAsk & { resolve: (allowed: boolean) => void };

const [queue, setQueue] = createSignal<ReadPrompt[]>([]);

/** いま画面に出す頼み（先頭 1 つ。残りは順に出す）。 */
export const currentReadPrompt = () => queue()[0];

/**
 * 読み取りの許可をユーザーに求める。そのたびに聞き、覚えない
 * （ssh 先のプログラムが手元のクリップボードを読めてしまうため）。
 * 返す cancel は、欄が閉じたときなど、答えが要らなくなったときに断りとして取り下げる。
 */
export function askClipboardRead(mimes: string[]): {
  allowed: Promise<boolean>;
  cancel: () => void;
} {
  return ask({ kind: "read", mimes });
}

/**
 * クリップボードの履歴を読む許可をユーザーに求める（`kisui clipboard history`。#517）。tab は頼んだ Pane の Terminal tab の名前。askClipboardRead と同じく、そのたびに聞き、覚えない。
 */
export function askClipboardHistory(tab: string): {
  allowed: Promise<boolean>;
  cancel: () => void;
} {
  return ask({ kind: "history", tab });
}

function ask(what: ReadAsk): {
  allowed: Promise<boolean>;
  cancel: () => void;
} {
  let entry!: ReadPrompt;
  const allowed = new Promise<boolean>((resolve) => {
    entry = {
      ...what,
      resolve: (ok) => {
        setQueue((q) => q.filter((e) => e !== entry));
        resolve(ok);
      },
    };
  });
  setQueue((q) => [...q, entry]);
  return { allowed, cancel: () => entry.resolve(false) };
}
