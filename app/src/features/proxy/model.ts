// プロキシのパネル（#409）の、通信の一覧の決まり。DOM も Tauri も Solid も使わない（node --test で確かめられる）。
//
// タブ（ターミナルのタブか、内蔵ブラウザのタブ）の HTTP・HTTPS の通信を、そのマシンの kisui serve のプロキシに通して記録する。
// 通す単位（scope）は kisui serve との取り決め（infrastructure/rpc/protocol.ts の proxy.*）：ターミナルのタブは
// "ws:<ワークスペースの id>"、ブラウザのタブは Window が決める "browser:<タブの id>"。
import type {
  ProxyFlow,
  ProxyFlowDetail,
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

/** 一覧のステータスの欄に出す字。応答がまだなら "…"、応答の無い失敗は "!"、止めている要求（#411）は "||"。 */
export function statusText(f: Pick<ProxyFlow, "status" | "state">): string {
  if (f.state === "held") return "||";
  if (f.status > 0) return String(f.status);
  return f.state === "failed" ? "!" : "…";
}

/** ステータスの色分け（ok：2xx・3xx、warn：4xx、error：5xx と失敗、pending：まだ、held：止めている）。 */
export function statusKind(
  f: Pick<ProxyFlow, "status" | "state">,
): "ok" | "warn" | "error" | "pending" | "held" {
  if (f.state === "held") return "held";
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

/**
 * 通信の進み具合（0：行き先に送る前に止めている、1：応答を待っている、2：応答のヘッダーが来た、3：終わった・失敗した）。
 * 同じ通信の 2 つの知らせのうち、どちらが新しいかを比べるのに使う（通信は進む方向にしか変わらない）。
 */
export function flowProgress(f: Pick<ProxyFlow, "status" | "state">): number {
  if (f.state === "held") return 0;
  if (f.state !== "pending") return 3;
  return f.status > 0 ? 2 : 1;
}

/**
 * 止めている要求（#411）のうち、いちばん古いものの id（except は数えない）。無ければ undefined。
 * 止めた順に 1 つずつ決めていけるよう、パネルが次に選ぶ通信。
 */
export function oldestHeld(
  flows: readonly ProxyFlow[],
  except?: number,
): number | undefined {
  return flows.find((f) => f.state === "held" && f.id !== except)?.id;
}

// ---- 書き換えて送り直す（#410）----

/**
 * 書き換える要求の本文。text が字の本文（書き換えて送る）。text が undefined なら、元の本文をそのまま送る（kisui serve が
 * 覚えたもの）。note は、字で書き換えられない理由：binary（字でない）・encoded（要求が圧縮してある）は元の本文をそのまま送る、
 * cut（記録の上限で切れている）は、そのままでは送れないので、書いた本文（空で始まる）を送る。
 * unread は、止めている要求（#411）の本文を kisui serve が読んでいない（大きさが分からない・大きい）。元の本文をそのまま送る。
 */
export interface ProxyDraftBody {
  text: string | undefined;
  note?: "binary" | "encoded" | "cut" | "unread";
  /** 元の本文の大きさ */
  size: number;
}

/** 書き換えている要求。headers は 1 行に 1 つ（`名前: 値`）。 */
export interface ProxyDraft {
  /** 元の通信の id */
  from: number;
  method: string;
  url: string;
  headers: string;
  body: ProxyDraftBody;
  /**
   * URL のホストと違う所につなぐときの、つなぐ先（host:port）。元の通信が Host と違う所につないでいた（curl --connect-to など）
   * ときだけ持つ（空にすると URL のホストにつなぐ）。無ければ undefined
   */
  connectTo?: string;
}

/** 書き換える欄に出さないヘッダー（本文から決まる・URL から決まる）。 */
const DERIVED_HEADERS = new Set(["content-length", "transfer-encoding"]);

/**
 * 記録した通信の中身 d から、書き換える要求の下書きを作る。Host は、URL のホストと同じなら出さない（URL から決まる。違うのは、
 * プロキシに絶対 URL で送った要求の Host が、URL と違うとき）。Host と違う所につないだ通信は、つないだ先を connectTo に持つ。
 * Content-Length・Transfer-Encoding は出さない（本文から決まる）。
 */
export function draftFrom(d: ProxyFlowDetail): ProxyDraft {
  const headers = d.reqHeaders.filter(([name, value]) => {
    const n = name.toLowerCase();
    if (DERIVED_HEADERS.has(n)) return false;
    return !(n === "host" && value === d.host);
  });
  const enc = d.reqHeaders.find(
    ([n]) => n.toLowerCase() === "content-encoding",
  );
  const encoded =
    enc !== undefined &&
    enc[1].trim() !== "" &&
    enc[1].trim().toLowerCase() !== "identity";
  const b = d.reqBody;
  let body: ProxyDraftBody;
  if (d.state === "held" && d.reqBodyUnread)
    body = { text: undefined, note: "unread", size: 0 };
  else if (b.truncated) body = { text: "", note: "cut", size: b.size };
  else if (b.size === 0) body = { text: "", size: 0 };
  else if (encoded) body = { text: undefined, note: "encoded", size: b.size };
  else if (b.text === undefined)
    body = { text: undefined, note: "binary", size: b.size };
  else body = { text: b.text, size: b.size };
  return {
    from: d.id,
    method: d.method,
    url: flowUrl(d),
    headers: headers.map(([n, v]) => `${n}: ${v}`).join("\n"),
    body,
    ...(d.connectTo ? { connectTo: d.connectTo } : {}),
  };
}

/**
 * 欄に書いたヘッダー text を、名前と値の並びにする。空の行は飛ばす。`名前: 値` の形でない行があれば、その行の番号（1 から）。
 */
export function parseHeaders(
  text: string,
): { headers: [string, string][] } | { badLine: number } {
  const headers: [string, string][] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const at = line.indexOf(":");
    const name = at < 0 ? "" : line.slice(0, at).trim();
    if (name === "" || /\s/.test(name)) return { badLine: i + 1 };
    headers.push([name, line.slice(at + 1).trim()]);
  }
  return { headers };
}
