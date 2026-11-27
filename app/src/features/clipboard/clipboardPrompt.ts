import { createSignal } from "solid-js";

/** 許可を待っている読み取りの頼み。 */
export interface ReadPrompt {
  /** 頼まれた MIME の種類（そのまま見せる） */
  mimes: string[];
  /** クリップボードの履歴を読む頼み（`kisui clipboard history`。#517）。無ければ、今のクリップボードを読む頼み（OSC 5522） */
  history?: true;
  /** 許す（true）か断る（false）か */
  resolve: (allowed: boolean) => void;
}

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
  return ask(mimes, false);
}

/**
 * クリップボードの履歴を読む許可をユーザーに求める（`kisui clipboard history`。#517）。askClipboardRead と同じく、そのたびに聞き、覚えない。
 */
export function askClipboardHistory(): {
  allowed: Promise<boolean>;
  cancel: () => void;
} {
  return ask([], true);
}

function ask(
  mimes: string[],
  history: boolean,
): { allowed: Promise<boolean>; cancel: () => void } {
  let entry!: ReadPrompt;
  const allowed = new Promise<boolean>((resolve) => {
    entry = {
      mimes,
      ...(history ? { history: true as const } : {}),
      resolve: (ok) => {
        setQueue((q) => q.filter((e) => e !== entry));
        resolve(ok);
      },
    };
  });
  setQueue((q) => [...q, entry]);
  return { allowed, cancel: () => entry.resolve(false) };
}
