import type { NotificationSupport, TerminalNotification } from "coneko-term";

/**
 * `p=?` への返事。公式の通知プラグインはデスクトップで押された・閉じられたを返さないので、
 * 押されたとき欄を前に出す（a=focus）は OS の既定に任せ、a=report と c=1 は対応しないと答える。
 * p=alive と p=close も、通知を後から調べる・閉じる口が無いので対応しないと答え、緊急度（u）も渡せないので対応しないと答える。
 * ここで省いた項目は coneko-term の既定（対応する）になる。
 */
export const notificationSupport: NotificationSupport = {
  actions: ["focus"],
  payloads: ["title", "body", "?"],
  urgencies: [],
  closeReport: false,
};

/** 通知を出すかどうか（`o`）。always は常に、unfocused は窓が前に無いとき、invisible は欄が見えていないとき。 */
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
