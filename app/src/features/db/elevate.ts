// DB の権限を、時間を決めて一時的に強める（#383）の、画面にも Solid にも Tauri にも依存しない部分（node --test で確かめられる）。
// 強めてよいか・いつまでかを決めて覚えるのは kisui serve（server/dbelevate.go）。窓は、強める・戻すを頼み、
// 強めていることと残りの時間を出すだけ。時間の書き方（"30m"・"1h30m"）を読むのも kisui serve で、窓は打たれた字をそのまま送る。
import { T } from "../../i18n/index.ts";
import { ErrorCode, RpcError } from "../../infrastructure/rpc/message.ts";
import type {
  DbConnection,
  DbElevateDeniedData,
  DbRun,
} from "../../infrastructure/rpc/protocol.ts";

/** 誰の権限か：人（窓）か、コーディングエージェント（kisui db のコマンド）。 */
export type DbActor = "human" | "agent";

/** 権限を持つ相手の全部（窓に並べる順：人・エージェント）。 */
export const ACTORS: readonly DbActor[] = ["human", "agent"];

/** 強める窓の 1 行：強められる権限 1 つ。 */
export interface ElevateRow {
  actor: DbActor;
  /** 元の権限の名前（強めている間も、元の名前） */
  from: string;
  /** 強めた間に使う権限の名前と、その間の実行の段階 */
  to: string;
  run: DbRun;
  /** 一度に強められる時間の上限（秒） */
  maxSeconds: number;
  /** 今強めていれば、答えたときの残りの時間（秒） */
  remainingSeconds?: number;
}

/** 接続 c の、強められる権限（人・エージェントの順。強められないものは入らない）。 */
export function elevateRows(c: DbConnection): ElevateRow[] {
  const rows: ElevateRow[] = [];
  for (const actor of ACTORS) {
    const a = c[actor];
    if (!a?.elevate) continue;
    rows.push({
      actor,
      from: a.elevated?.from ?? a.permission,
      to: a.elevate.to,
      run: a.elevate.run,
      maxSeconds: a.elevate.maxSeconds,
      ...(a.elevated ? { remainingSeconds: a.elevated.remainingSeconds } : {}),
    });
  }
  return rows;
}

/** 今強めている権限 1 つ（窓が覚える形）。 */
export interface Elevation {
  actor: DbActor;
  /** 強めた間に使っている権限の名前 */
  permission: string;
  /** 元に戻る時刻（窓の時計のミリ秒。答えを受けた時刻に、残りの時間を足したもの） */
  deadline: number;
}

/** 接続 c の、今強めている権限。now は答えを受けた時刻（窓の時計のミリ秒）。 */
export function elevationsOf(c: DbConnection, now: number): Elevation[] {
  const out: Elevation[] = [];
  for (const actor of ACTORS) {
    const a = c[actor];
    if (!a?.elevated) continue;
    out.push({
      actor,
      permission: a.permission,
      deadline: now + a.elevated.remainingSeconds * 1000,
    });
  }
  return out;
}

/** 時刻 now に、deadline までの残りの秒（切り上げ。過ぎていれば 0）。 */
export function remainingSeconds(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * 秒 seconds を、kisui serve が読む時間の書き方にする（"30m"・"1h30m"・"1m30s"。0 の単位は書かない）。
 * 強める窓の入力欄に、上限の時間を初めから入れておくのに使う。
 */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const parts = [
    [Math.floor(s / 3600), "h"],
    [Math.floor((s % 3600) / 60), "m"],
    [s % 60, "s"],
  ] as const;
  const text = parts
    .filter(([n]) => n > 0)
    .map(([n, unit]) => `${n}${unit}`)
    .join("");
  return text === "" ? "0s" : text;
}

/** 残りの時間の字：1 分より短ければ秒（"45s"）、長ければ分に切り上げる（"12m"・"1h5m"）。 */
export function remainingText(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  return durationText(Math.ceil(s / 60) * 60);
}

/** 誰の権限かの字（「自分」「コーディングエージェント」）。 */
export function actorText(actor: DbActor): string {
  return T(actor === "human" ? "db.elevate.human" : "db.elevate.agent");
}

/** DB のタブの見出しに出す、強めていることと残りの時間の字（強めているものごとに 1 つ）。 */
export function elevationTexts(
  list: readonly Elevation[],
  now: number,
): string[] {
  return list.map((e) =>
    T("db.elevate.badge", {
      who: actorText(e.actor),
      permission: e.permission,
      time: remainingText(remainingSeconds(e.deadline, now)),
    }),
  );
}

/** db.elevate・db.elevateEnd が投げたものを、窓に出す文にする。 */
export function elevateFailure(e: unknown): string {
  if (e instanceof RpcError) {
    if (e.code === ErrorCode.Denied) {
      const d = (e.data ?? {}) as Partial<DbElevateDeniedData>;
      if (d.reason === "over_max" && typeof d.maxSeconds === "number")
        return T("db.elevate.err.overMax", {
          max: durationText(d.maxSeconds),
        });
      if (d.reason === "not_elevatable")
        return T("db.elevate.err.notElevatable");
    }
    if (e.code === ErrorCode.InvalidParams) return T("db.elevate.err.time");
    if (e.code === ErrorCode.NotFound) return T("db.err.noConnection");
    return e.reason;
  }
  return e instanceof Error ? e.message : String(e);
}
