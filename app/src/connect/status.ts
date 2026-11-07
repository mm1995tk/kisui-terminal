// 接続の状態を言葉にする。左の一覧の見出しの下の 1 行（statusLine）と、新しい版への切り替えの失敗（handoverFailure）と、
// リモートを足す窓に出す状態（stateLabel）と、引き継いだ GUI の説明（describeClient）。
// 画面の仕組み（Solid）には依存しない。

import type { SessionState } from "../ssh/session.ts";

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
      const n = s.attempt > 1 ? `（${s.attempt} 回目）` : "";
      if (s.retryAt !== undefined) {
        return {
          text: `つなげませんでした${n}`,
          title: s.reason ?? "",
          retry: "now",
          countdown: `${secondsLeft(s.retryAt, now)} 秒後にもう一度`,
        };
      }
      return { text: `つないでいます…${n}`, title: s.reason ?? "" };
    }
    case "connected":
      return {
        text: "",
        title: s.handoverError
          ? `つながっています（古い版の kisui ${s.hello.shj.version} のまま）`
          : `つながっています（kisui ${s.hello.shj.version}）`,
      };
    case "reconnecting": {
      if (s.switching) return switchingLine(s, now);
      const text = `再接続中（${s.attempt} 回目）`;
      if (s.retryAt !== undefined) {
        return {
          text,
          title: s.reason,
          retry: "now",
          countdown: `${secondsLeft(s.retryAt, now)} 秒後`,
        };
      }
      return { text, title: s.reason };
    }
    case "needs-install":
      return { text: "kisui がありません", title: "" };
    case "installing":
      return { text: "kisui を入れています…", title: "" };
    case "failed":
      return { text: "つながりません", title: s.message, retry: "again" };
    case "superseded": {
      const who = s.by ? describeClient(s.by) : "";
      return {
        text: "別の kisui-terminal に移りました",
        title: who ? `別の kisui-terminal に移りました（${who}）` : "",
        retry: "again",
      };
    }
    case "closed":
      return { text: "", title: "" };
  }
}

/** 新しい版の kisui serve に切り替えている間の言葉（#8） */
export const SWITCHING = "新しい版に切り替えています";

/** 切り替えている間の 1 行。つなぎ直しに手間取っていれば、理由をツールチップに、待ち時間とボタンを出す。 */
function switchingLine(
  s: Extract<SessionState, { kind: "connecting" | "reconnecting" }>,
  now: number,
): MachineStatus {
  const line = { text: `${SWITCHING}…`, title: s.reason ?? "" };
  if (s.retryAt === undefined) return line;
  return {
    ...line,
    retry: "now",
    countdown: `${secondsLeft(s.retryAt, now)} 秒後`,
  };
}

/** リモートを足す窓で、つないでいる最中に出す短い状態。まだつないでいなければ ""。 */
export function stateLabel(s: SessionState | undefined): string {
  switch (s?.kind) {
    case undefined:
    case "closed":
      return "";
    case "connected":
      return "接続中";
    case "connecting":
      return s.switching ? SWITCHING : "つないでいます";
    case "reconnecting":
      return s.switching ? SWITCHING : "再接続中";
    case "needs-install":
      return "kisui がありません";
    case "installing":
      return "kisui を入れています";
    case "failed":
      return "つながりません";
    case "superseded":
      return "別の kisui-terminal に移りました";
  }
}

/** もう一度つなぐ意味がある（窓の「つなぐ」を押せる）状態か。 */
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
    : `${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} から`;
  return [name, time].filter((x) => x !== "").join("、");
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
    title: `${label} の kisui を新しい版に切り替えられませんでした`,
    text:
      `古い版の kisui（${s.hello.shj.version}）のまま使い続けます。` +
      "欄のシェルと画面はそのままです。",
    error: s.handoverError,
  };
}
