import type { NotificationSupport, TerminalNotification } from "coneko-term";

/**
 * OS の通知を出す。`onResponse` は押された・閉じられたのとき 1 回だけ呼ばれる。出せなければ例外。
 * `focus` が真なら、押されたとき殻が Window を前に出す。返す関数は、欄が無くなるときに呼ぶ（以後の返事を捨てる）。
 * 本物は infrastructure/tauri/notify.ts。
 */
export type ShowOsNotification = (
  n: { title: string; body?: string },
  focus: boolean,
  onResponse: (kind: "activated" | "closed") => void,
) => Promise<() => void>;

/**
 * `p=?` への返事。押されたとき欄を前に出す（a=focus）と、押されたの返事（a=report）は 3 つの OS とも対応する。
 * 閉じられたの返事（c=1）は macOS だけ対応しない（NSUserNotification は閉じられたと期限切れを区別できず取れない）。
 * p=alive と p=close は、通知を後から調べる・閉じる口が無いので対応しないと答え、緊急度（u）も渡せないので対応しないと答える。
 * ここで省いた項目は coneko-term の既定（対応する）になる。
 * `userAgent` は navigator.userAgent。
 */
export function notificationSupportFor(userAgent: string): NotificationSupport {
  const mac = /Mac/i.test(userAgent);
  return {
    actions: ["focus", "report"],
    payloads: ["title", "body", "?"],
    urgencies: [],
    closeReport: !mac,
  };
}

/** 通知を出すかどうか（`o`）。always は常に、unfocused は Window が前に無いとき、invisible は欄が見えていないとき。 */
export function shouldNotify(
  when: TerminalNotification["when"],
  state: { windowFocused: boolean; cellVisible: boolean; pageVisible: boolean },
): boolean {
  switch (when) {
    case "always":
      return true;
    case "unfocused":
      return !state.windowFocused;
    case "invisible":
      return !state.cellVisible || !state.pageVisible;
  }
}

/**
 * OS の通知に渡す題名と本文。公式プラグインのデスクトップ版には緊急度（u）を渡す口が無いので渡せない。
 * 題名が空なら本文を題名にする。
 */
export function toOsNotification(n: TerminalNotification): {
  title: string;
  body?: string;
} {
  const title = n.title || n.body || n.appName || "shijimi-editor";
  const body = n.title && n.body ? n.body : undefined;
  return { title, body };
}
