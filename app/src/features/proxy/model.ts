// プロキシのパネル（#409）の、通信の一覧の決まり。DOM も Tauri も Solid も使わない（node --test で確かめられる）。
//
// タブ（ターミナルのタブか、内蔵ブラウザのタブ）の HTTP・HTTPS の通信を、そのマシンの kisui serve のプロキシに通して記録する。
// 通す単位（scope）は kisui serve との取り決め（infrastructure/rpc/protocol.ts の proxy.*）：ターミナルのタブは
// "ws:<ワークスペースの id>"、ブラウザのタブは窓が決める "browser:<タブの id>"。
import type {
  ProxyFlow,
  WorkspaceId,
} from "../../infrastructure/rpc/protocol.ts";

/** 画面が持つ通信の数の上限（kisui serve が覚える数と同じ）。超えたら古いものから捨てる。 */
export const MAX_FLOWS = 1000;

/** ターミナルのタブ（マシンのワークスペース ws）の scope。kisui serve が決める形と同じ。 */
export const wsScope = (ws: WorkspaceId): string => `ws:${ws}`;

/** ブラウザのタブ tab の scope。 */
export const browserScope = (tab: string): string => `browser:${tab}`;

/** マシン target の scope を指すキー（scope はマシンごとに別）。 */
export const scopeKey = (target: string, scope: string): string =>
  JSON.stringify([target, scope]);

/**
 * 一覧 flows（id の順）に、届いた通信 f を入れる。同じ id があれば置き換え、無ければ id の順の場所に足す。
 * max を超えたら古いものから捨てる。
 */
export function applyFlow(
  flows: readonly ProxyFlow[],
  f: ProxyFlow,
  max: number = MAX_FLOWS,
): ProxyFlow[] {
  // ほとんどは末尾（いちばん新しい通信）に当たるので、後ろから探す
  let i = flows.length - 1;
  while (i >= 0 && flows[i]!.id > f.id) i--;
  const next =
    i >= 0 && flows[i]!.id === f.id
      ? [...flows.slice(0, i), f, ...flows.slice(i + 1)]
      : [...flows.slice(0, i + 1), f, ...flows.slice(i + 1)];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** 通信の URL（一覧の 1 行に出す）。 */
export const flowUrl = (f: Pick<ProxyFlow, "scheme" | "host" | "path">) =>
  `${f.scheme}://${f.host}${f.path}`;

/** 本文の大きさの短い書き方（512 B、1.5 kB、2.0 MB）。 */
export function formatSize(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)} kB`;
  return `${(n / 1000 / 1000).toFixed(1)} MB`;
}

/** かかった時間の短い書き方（42 ms、1.2 s）。 */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** 始まった時刻（時:分:秒）。 */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 一覧のステータスの欄に出す字。応答がまだなら "…"、応答の無い失敗は "!"。 */
export function statusText(f: Pick<ProxyFlow, "status" | "state">): string {
  if (f.status > 0) return String(f.status);
  return f.state === "failed" ? "!" : "…";
}

/** ステータスの色分け（ok：2xx・3xx、warn：4xx、error：5xx と失敗、pending：まだ）。 */
export function statusKind(
  f: Pick<ProxyFlow, "status" | "state">,
): "ok" | "warn" | "error" | "pending" {
  if (f.state === "failed" || f.status >= 500) return "error";
  if (f.status >= 400) return "warn";
  if (f.status > 0) return "ok";
  return "pending";
}

/**
 * 選んでいる通信（id。無ければ undefined）から、step（next・prev・first・last）で移った先の id。
 * 何も選んでいなければ、next・last はいちばん新しいもの、prev・first はいちばん古いものを選ぶ。通信が無ければ undefined。
 */
export function stepSelection(
  flows: readonly ProxyFlow[],
  selected: number | undefined,
  step: "next" | "prev" | "first" | "last",
): number | undefined {
  if (flows.length === 0) return undefined;
  const last = flows.length - 1;
  const at = flows.findIndex((f) => f.id === selected);
  let to: number;
  if (step === "first") to = 0;
  else if (step === "last") to = last;
  else if (at < 0) to = step === "next" ? last : 0;
  else to = Math.min(last, Math.max(0, at + (step === "next" ? 1 : -1)));
  return flows[to]!.id;
}
