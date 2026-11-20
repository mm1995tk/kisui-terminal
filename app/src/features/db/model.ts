// DB のタブ（#347）の、画面にも Solid にも Tauri にも依存しない部分（node --test で確かめられる）。
// - 書きかけの SQL の記録（KeyValueStore。置き場とその理由は controller.ts の頭）
// - 窓がつないでいる全部のマシンの接続の一覧を、1 つの一覧にまとめる
// - kisui serve の断り（password_required・db_error など）を、画面で扱う形にする
// - 結果の値・件数・かかった時間を、画面に出す文字にする
// タブそのもの（どのワークスペースの、どのマシンの、どの接続か・並び）は features/workspaces/model.ts の DbRef が持つ。

import { T } from "../../i18n/index.ts";
import { ErrorCode, RpcError } from "../../infrastructure/rpc/message.ts";
import type {
  DbConnection,
  DbErrorData,
  DbPasswordRequiredData,
  DbQueryResult,
} from "../../infrastructure/rpc/protocol.ts";
import type { KeyValueStore } from "../keyValueStore.ts";

// ---- 書きかけの SQL の記録 ----

/** localStorage のキー。 */
export const DB_TABS_KEY = "kisui-terminal.dbTabs";

/** 記録の形の版。形を変えたら上げる（読めない版の記録は捨てる）。 */
const FORMAT_VERSION = 1;

/** 記録するもの：DB のタブの id → 入力欄の書きかけの SQL。空の SQL は書かない。 */
export type Drafts = Readonly<Record<string, string>>;

/** 記録を読む。無い・壊れている・版が違うときは空。 */
export function loadDrafts(store: KeyValueStore | undefined): Drafts {
  try {
    const raw = store?.getItem(DB_TABS_KEY);
    return raw ? parseDrafts(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** 記録の形を確かめる。形の違うものは捨てる。 */
export function parseDrafts(v: unknown): Drafts {
  if (typeof v !== "object" || v === null) return {};
  const o = v as { version?: unknown; sql?: unknown };
  if (o.version !== FORMAT_VERSION) return {};
  if (typeof o.sql !== "object" || o.sql === null) return {};
  const out: Record<string, string> = {};
  for (const [id, sql] of Object.entries(o.sql))
    if (typeof sql === "string" && sql !== "") out[id] = sql;
  return out;
}

/** 記録を書く（ids にあるタブの分だけ。閉じたタブの書きかけは捨てる）。書けなくても、今回の分は変わる。 */
export function saveDrafts(
  store: KeyValueStore | undefined,
  drafts: Drafts,
  ids: ReadonlySet<string>,
): void {
  const sql: Record<string, string> = {};
  for (const [id, s] of Object.entries(drafts))
    if (ids.has(id) && s !== "") sql[id] = s;
  try {
    store?.setItem(
      DB_TABS_KEY,
      JSON.stringify({ version: FORMAT_VERSION, sql }),
    );
  } catch {
    // 保存できなくても、今回は使える
  }
}

// ---- 接続の一覧 ----

/** 接続を選ぶ一覧の 1 行：どのマシンの、どの接続か。 */
export interface DbChoice {
  /** 接続を書いたマシン（ssh の行き先か `@local`） */
  target: string;
  /** マシンの名前（画面に出す） */
  machine: string;
  /** マシンの色 */
  color: string;
  connection: DbConnection;
}

/** 1 台のマシンから集めたもの。connections は db.connections の答え、error は聞けなかった理由。 */
export interface MachineConnections {
  target: string;
  machine: string;
  color: string;
  connections?: readonly DbConnection[];
  /** db.connections の problems（設定の間違い。間違いのある接続は connections に入らない） */
  problems?: readonly string[];
  error?: string;
}

/** まとめた一覧と、一覧の下に出す知らせ（どのマシンの、何か）。 */
export interface CollectedConnections {
  choices: DbChoice[];
  notes: string[];
}

/** マシンごとに集めたものを、1 つの一覧にまとめる（マシンの並びの順、その中は設定に書いた順）。 */
export function collectConnections(
  machines: readonly MachineConnections[],
): CollectedConnections {
  const choices: DbChoice[] = [];
  const notes: string[] = [];
  for (const m of machines) {
    for (const c of m.connections ?? [])
      choices.push({
        target: m.target,
        machine: m.machine,
        color: m.color,
        connection: c,
      });
    for (const p of m.problems ?? [])
      notes.push(T("db.picker.problem", { machine: m.machine, problem: p }));
    if (m.error !== undefined)
      notes.push(T("db.picker.failed", { machine: m.machine, error: m.error }));
  }
  return { choices, notes };
}

/** 接続の行き先の短い説明（`postgres · app@db.example:5432/shop`。Unix ソケットはそのパス）。 */
export function connectionDetail(c: DbConnection): string {
  const where = c.host.startsWith("/") ? c.host : `${c.host}:${c.port}`;
  const db = c.database ? `/${c.database}` : "";
  const user = c.user ? `${c.user}@` : "";
  return `${c.kind} · ${user}${where}${db}`;
}

// ---- kisui serve の断り ----

/** SQL を実行できなかった理由（画面に出す形）。 */
export type QueryFailure =
  /** パスワードが要る（どこにも無い・入力したものを DB が断った）。聞いて送り直す */
  | { kind: "password"; reason: DbPasswordRequiredData["reason"] }
  /** 取り消した */
  | { kind: "cancelled" }
  /** それ以外。message をそのまま出す */
  | { kind: "error"; message: string; sqlState?: string };

/** 要求が投げたものを、QueryFailure にする。 */
export function queryFailure(e: unknown): QueryFailure {
  if (e instanceof RpcError) {
    if (e.code === ErrorCode.PasswordRequired) {
      const d = e.data as Partial<DbPasswordRequiredData> | undefined;
      return {
        kind: "password",
        reason: d?.reason === "rejected" ? "rejected" : "missing",
      };
    }
    if (e.code === ErrorCode.DbError) {
      const d = (e.data ?? {}) as Partial<DbErrorData>;
      if (d.kind === "cancelled") return { kind: "cancelled" };
      return {
        kind: "error",
        message: e.reason,
        ...(d.sqlState ? { sqlState: d.sqlState } : {}),
      };
    }
    if (e.code === ErrorCode.NotFound)
      return { kind: "error", message: T("db.err.noConnection") };
    if (e.code === ErrorCode.Busy)
      return { kind: "error", message: T("db.err.busy") };
    return { kind: "error", message: e.reason };
  }
  return { kind: "error", message: e instanceof Error ? e.message : String(e) };
}

// ---- 結果を画面に出す ----

/** 1 つのセルに出す字の上限（それより長い値は切って「…」を付ける。全部はセルのツールチップに出す）。 */
export const CELL_MAX = 200;

/** セルに出す字。NULL は null（画面は NULL の印を出す）。改行とタブは見える字にし、長い値は切る。 */
export function cellText(v: string | null, max = CELL_MAX): string | null {
  if (v === null) return null;
  const flat = v.replace(/\r\n|\r|\n/g, "↵").replace(/\t/g, "⇥");
  return [...flat].length > max ? `${[...flat].slice(0, max).join("")}…` : flat;
}

/** かかった時間（1 秒より短ければミリ秒、長ければ秒）。 */
export function elapsedText(ms: number): string {
  if (ms < 1000)
    return T("db.elapsed.ms", { n: ms < 10 ? ms.toFixed(1) : Math.round(ms) });
  return T("db.elapsed.s", { n: (ms / 1000).toFixed(2) });
}

/** 結果の表の下に出す、件数とかかった時間（行を返す文は行数、返さない文は変えた行数）。 */
export function resultSummary(r: DbQueryResult): string {
  const parts: string[] = [];
  if (r.columns.length > 0) {
    parts.push(T("db.summary.rows", { n: r.rowCount }));
    if (r.truncated) parts.push(T("db.summary.truncated"));
  } else if (r.rowsAffected !== undefined)
    parts.push(T("db.summary.affected", { n: r.rowsAffected }));
  else parts.push(T("db.summary.done"));
  if (r.truncatedCells) parts.push(T("db.summary.truncatedCells"));
  parts.push(elapsedText(r.elapsedMs));
  return parts.join(" · ");
}

/** db.cancel で取り消すための、窓が付ける名前。 */
export function newQueryId(random: () => number = Math.random): string {
  let s = "q";
  for (let i = 0; i < 12; i++) s += Math.floor(random() * 36).toString(36);
  return s;
}

/** パスワードを聞く窓をやめた（要求は送らずに終える）。 */
export class PasswordCancelled extends Error {
  constructor() {
    super("password cancelled");
    this.name = "PasswordCancelled";
  }
}

/**
 * send（password を付けて要求を送る。undefined なら付けない）を呼ぶ。kisui serve が password_required を返したら、
 * ask でパスワードを聞いて、それを付けて送り直す（DB が断った rejected なら、また聞く）。ask が null（やめた）なら
 * PasswordCancelled を投げる。ほかの断りは、そのまま投げる。聞いたパスワードは、この中の変数にだけ持つ。
 */
export async function withPassword<R>(
  send: (password: string | undefined) => Promise<R>,
  ask: (reason: DbPasswordRequiredData["reason"]) => Promise<string | null>,
): Promise<R> {
  let password: string | undefined;
  for (;;) {
    try {
      return await send(password);
    } catch (e) {
      const f = queryFailure(e);
      if (f.kind !== "password") throw e;
      const p = await ask(f.reason);
      if (p === null) throw new PasswordCancelled();
      password = p;
    }
  }
}

/** 木のペインの一覧を聞けなかった理由の文（PasswordCancelled はパスワードを入れなかった、それ以外は queryFailure の分け方）。 */
export function catalogError(e: unknown): string {
  if (e instanceof PasswordCancelled) return T("db.tree.passwordCancelled");
  const f = queryFailure(e);
  switch (f.kind) {
    case "error":
      return f.message;
    case "cancelled":
      return T("db.view.cancelled");
    case "password":
      return T("db.err.password");
  }
}
