// 接続の状態を言葉にする。左の一覧の見出しの下の 1 行（statusLine）と、新しい版への切り替えの失敗（handoverFailure）と、
// リモートを足す Dialog に出す状態（stateLabel）と、引き継いだ GUI の説明（describeClient）。
// 画面の仕組み（Solid）には依存しない。

import { T } from "../../i18n/index.ts";
import type { SessionState } from "./session.ts";

/** 見出しのそばのボタン。now は待ち時間を飛ばして今すぐ、again は使い切った・引き継がれたあとにつなぎ直す。 */
export type RetryKind = "now" | "again";

/** 見出しの下に出すもの。text が "" なら行を出さない。 */
export interface MachineStatus {
  text: string;
  /** ツールチップ（長い説明） */
  title: string;
  retry?: RetryKind;
  /** 待ち時間の残り（「3 秒後」）。毎秒変わるので、読み上げる text とは分けて出す */
  countdown?: string;
}

const secondsLeft = (at: number, now: number) =>
  Math.max(0, Math.ceil((at - now) / 1000));

/** 左の一覧の見出しの下の短い 1 行（モックの「再接続中（2 回目）」）。つながっていれば ""。 */
export function statusLine(
  s: SessionState | undefined,
  now: number = Date.now(),
): MachineStatus {
  if (!s) return { text: "", title: "" };
  switch (s.kind) {
    case "connecting": {
      if (s.switching) return switchingLine(s, now);
      const n = s.attempt > 1 ? T("status.attempt", { n: s.attempt }) : "";
      if (s.retryAt !== undefined) {
        return {
          text: T("status.connectFailed", { attempt: n }),
          title: s.reason ?? "",
          retry: "now",
          countdown: T("status.retryNow", { n: secondsLeft(s.retryAt, now) }),
        };
      }
      return {
        text: T("status.connecting", { attempt: n }),
        title: s.reason ?? "",
      };
    }
    case "connected":
      return {
        text: "",
        title: s.handoverError
          ? T("status.connected.old", { version: s.hello.shj.version })
          : T("status.connected", { version: s.hello.shj.version }),
      };
    case "reconnecting": {
      if (s.switching) return switchingLine(s, now);
      const text = T("status.reconnecting", {
        attempt: T("status.attempt", { n: s.attempt }),
      });
      if (s.retryAt !== undefined) {
        return {
          text,
          title: s.reason,
          retry: "now",
          countdown: T("status.in", { n: secondsLeft(s.retryAt, now) }),
        };
      }
      return { text, title: s.reason };
    }
    case "needs-install":
      return { text: T("status.noKisui"), title: "" };
    case "installing":
      return { text: T("status.installing"), title: "" };
    case "failed":
      return {
        text: T("status.cannotConnect"),
        title: s.message,
        retry: "again",
      };
    case "superseded": {
      const who = s.by ? describeClient(s.by) : "";
      return {
        text: T("status.superseded"),
        title: who ? T("status.superseded.by", { who }) : "",
        retry: "again",
      };
    }
    case "closed":
      return { text: "", title: "" };
  }
}

/** 新しい版の kisui serve に切り替えている間の言葉（#8） */
export const switching = (): string => T("status.switching");

/** 切り替えている間の 1 行。つなぎ直しに手間取っていれば、理由をツールチップに、待ち時間とボタンを出す。 */
function switchingLine(
  s: Extract<SessionState, { kind: "connecting" | "reconnecting" }>,
  now: number,
): MachineStatus {
  const line = { text: `${switching()}…`, title: s.reason ?? "" };
  if (s.retryAt === undefined) return line;
  return {
    ...line,
    retry: "now",
    countdown: T("status.in", { n: secondsLeft(s.retryAt, now) }),
  };
}

/** リモートを足す Dialog で、つないでいる最中に出す短い状態。まだつないでいなければ ""。 */
export function stateLabel(s: SessionState | undefined): string {
  switch (s?.kind) {
    case undefined:
    case "closed":
      return "";
    case "connected":
      return T("status.label.connected");
    case "connecting":
      return s.switching ? switching() : T("status.label.connecting");
    case "reconnecting":
      return s.switching ? switching() : T("status.label.reconnecting");
    case "needs-install":
      return T("status.noKisui");
    case "installing":
      return T("status.label.installing");
    case "failed":
      return T("status.cannotConnect");
    case "superseded":
      return T("status.superseded");
  }
}

/** もう一度つなぐ意味がある（Dialog の「つなぐ」を押せる）状態か。 */
export function canConnect(s: SessionState | undefined): boolean {
  return (
    s === undefined ||
    s.kind === "closed" ||
    s.kind === "failed" ||
    s.kind === "superseded"
  );
}

/** 引き継いだ GUI を短く言う（「名前 版、HH:MM から」）。読めないところは省き、何も無ければ ""。 */
export function describeClient(
  by: NonNullable<Extract<SessionState, { kind: "superseded" }>["by"]>,
): string {
  const name = [by.client?.name, by.client?.version]
    .filter((x) => typeof x === "string" && x !== "")
    .join(" ");
  const at = new Date(by.connectedAt);
  const time = Number.isNaN(at.getTime())
    ? ""
    : T("client.since", {
        time: at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      });
  return [name, time].filter((x) => x !== "").join(T("client.join"));
}

/**
 * 新しい版への切り替え（server.handover）が断られ、古い版の kisui serve のまま使っているときの知らせの中身。
 * そうでなければ undefined。label はマシンの名前。
 */
export function handoverFailure(
  label: string,
  s: SessionState | undefined,
): { title: string; text: string; error: string } | undefined {
  if (s?.kind !== "connected" || s.handoverError === undefined) return;
  return {
    title: T("status.handover.title", { machine: label }),
    text: T("status.handover.text", { version: s.hello.shj.version }),
    error: s.handoverError,
  };
}
