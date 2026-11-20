// 文を 2 つ以上順に実行したときの、文ごとの結果のタブ（#380）の、画面にも Solid にも依存しない部分（node --test で確かめられる）。
// 選んだ部分の文は、上から 1 つずつ別の db.query で送る（1 つのトランザクションでは包まない）。失敗した・取り消したら、そこで止める。
// 実行した文 1 つにつき、結果の場所にタブを 1 つ出す（文が 1 つだけのときは、タブの列を出さない）。

import type { DbQueryResult } from "../../infrastructure/rpc/protocol.ts";
import type { QueryFailure } from "./model.ts";
import type { DbPage } from "./paging.ts";

/** 文 1 つの結果。 */
export interface DbStatementRun {
  /** 実行した文（タブの見出しと、ツールチップ） */
  sql: string;
  /** 文の結果 */
  result?: DbQueryResult;
  /** result がどの SQL のどのページか（ページ送り。#373）。result があれば入っている */
  page?: DbPage;
  /** 文が失敗した・取り消した理由（あれば result の代わりに出す） */
  failure?: Exclude<QueryFailure, { kind: "password" }>;
}

/** タブ 1 つの、メモリだけに持つ状態。 */
export interface DbRun {
  /** 実行している SQL（db.cancel に渡す名前と、送ったマシンと、どの文の結果になるか）。パスワードを聞いている間も入っている */
  running?: { queryId: string; target: string; index: number };
  /** 最後の実行の、文ごとの結果（上から順。実行を始めた文だけ。失敗して止めた後の文は無い） */
  statements: readonly DbStatementRun[];
  /** 結果の場所に出している文（statements の位置） */
  active: number;
}

/** まだ実行していないタブの状態。 */
export const EMPTY_RUN: DbRun = { statements: [], active: 0 };

/** 結果の場所に出している文の結果（まだ実行していなければ undefined）。 */
export function activeStatement(r: DbRun): DbStatementRun | undefined {
  return r.statements[r.active];
}

/** 結果の場所に出している文を、今実行しているか。 */
export function activeRunning(r: DbRun): boolean {
  return r.running !== undefined && r.running.index === r.active;
}

/**
 * r に、位置 index の文 sql を実行し始めた印を付けた状態。index が新しい文（statements の後ろ）なら足す。
 * 出している結果は、実行している文に付いていく。ただし、順に実行している間に利用者が前の文の結果に切り替えていたら、
 * そのまま（今実行している文の 1 つ前を出しているときだけ付いていく）。
 */
export function startStatement(
  r: DbRun,
  index: number,
  sql: string,
  running: { queryId: string; target: string },
): DbRun {
  if (index < r.statements.length)
    return { ...r, running: { ...running, index } };
  const follow = r.statements.length === 0 || r.active === index - 1;
  return {
    statements: [...r.statements, { sql }],
    active: follow ? index : r.active,
    running: { ...running, index },
  };
}

/** r の位置 index の文の結果を f で替えた状態（running は変えない）。 */
export function updateStatement(
  r: DbRun,
  index: number,
  f: (s: DbStatementRun) => DbStatementRun,
): DbRun {
  const s = r.statements[index];
  if (!s) return r;
  const statements = [...r.statements];
  statements[index] = f(s);
  return { ...r, statements };
}

/** 結果のタブを step（1 は次、-1 は前）だけ動いた位置。端では動かない（回らない）。 */
export function stepResult(r: DbRun, step: 1 | -1): number {
  const n = r.statements.length;
  if (n === 0) return r.active;
  return Math.min(n - 1, Math.max(0, r.active + step));
}

/** 結果のタブの見出しの字数の上限（これより長い文は切って「…」）。 */
export const RESULT_LABEL_MAX = 24;

/**
 * 結果のタブの見出し：文の先頭の字。前にあるコメント（`--` `#` の行と `/* *\/`）を除き、改行と続く空白を 1 つの空白にして、
 * max 字より長ければ切って「…」を付ける。文がコメントだけなら、詰めた文そのもの。
 */
export function resultTabLabel(sql: string, max = RESULT_LABEL_MAX): string {
  let s = sql.trim();
  for (;;) {
    const m = /^(?:(?:--|#)[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*/.exec(s);
    if (!m || m[0].length === s.length) break;
    s = s.slice(m[0].length);
  }
  const one = s.replace(/\s+/g, " ").trim();
  const chars = [...one];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : one;
}

/** 文 1 つを実行した結果。ok：うまくいった、failed：失敗した・取り消した、gone：タブが閉じた・ほかの実行に替わった。 */
export type StatementOutcome = "ok" | "failed" | "gone";

/**
 * 文 sqls を上から 1 つずつ runOne で実行する（#380）。前の文が終わってから次を送る。
 * - 文が ok でなければ（failed・gone）、そこで止めて、その結果を返す（後の文は送らない）
 * - 後に文が残っていて stopRequested が真なら（取り消しが届く前に文が終わっていた）、"stopped" を返す
 * - 全部 ok なら "done"。最後の文の後では stopRequested を見ない（残りが無いので）
 * runOne の more は、後に文が残っているか。
 */
export async function runInOrder(
  sqls: readonly string[],
  runOne: (
    index: number,
    sql: string,
    more: boolean,
  ) => Promise<StatementOutcome>,
  stopRequested: () => boolean,
): Promise<"done" | "stopped" | "failed" | "gone"> {
  for (let i = 0; i < sqls.length; i++) {
    const more = i < sqls.length - 1;
    const out = await runOne(i, sqls[i]!, more);
    if (out !== "ok") return out;
    if (more && stopRequested()) return "stopped";
  }
  return "done";
}
