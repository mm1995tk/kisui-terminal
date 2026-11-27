// DB のタブの結果のページ送り（#373）の、画面にも Solid にも依存しない部分（node --test で確かめられる）。
// kisui serve は SQL の 1 つごとにログインし直すので、続きを読むカーソルは残らない。ページを切り替えるたびに、
// 結果を出した SQL を、db.query の offset を付けてもう一度送る。kisui serve がその SQL を
// `SELECT * FROM (SQL) AS q LIMIT 1001 OFFSET n` と包んで実行する（internal/db の wrap.go）。
// 包めるか（SELECT か。MySQL では列の名前が重ならないか）は kisui serve が決め、結果の wrappable で返す。

import type { DbQueryResult } from "../../infrastructure/rpc/protocol.ts";

/** 結果の表に出している行が、どの SQL の、どのページか。 */
export interface DbPage {
  /** 結果を出した SQL（ページを切り替えるときに、もう一度送る。入力欄をそのあと書き換えても変わらない） */
  sql: string;
  /** 前のページの offset（古い順）。「前へ」はその最後に戻る（1 ページの行数は 8 MiB の上限で減ることがあるので、引き算では戻らない） */
  back: readonly number[];
  /** 並べ替えている列（無ければ元の順。ページを切り替えても続く。#377） */
  sort?: DbSort;
  /** 実行したときのタブの既定のスキーマ（#378。db.query の schema）。ページを切り替えても、あとで選び直しても、この結果の続きは同じスキーマで読む */
  schema?: string;
}

/** ページを切り替える向き。 */
export type PageStep = "next" | "prev";

/** 次に送る offset と、そのページの DbPage の back。 */
export interface PageTarget {
  offset: number;
  back: number[];
}

/** 結果 r がページ送りを出すか：包める文で、2 ページ以上ある（後ろに行が残っているか、先頭のページでない）。 */
export function pageable(r: DbQueryResult): boolean {
  return r.wrappable === true && (r.truncated || (r.offset ?? 0) > 0);
}

/** 結果 r の前・次のページへ行けるか。 */
export function canStep(r: DbQueryResult, page: DbPage, step: PageStep) {
  return pageTarget(r, page, step) !== null;
}

/** 結果 r（ページ page）から step の向きに切り替えるときの、送る offset。行けなければ null。 */
export function pageTarget(
  r: DbQueryResult,
  page: DbPage,
  step: PageStep,
): PageTarget | null {
  if (!pageable(r)) return null;
  const offset = r.offset ?? 0;
  if (step === "next") {
    if (!r.truncated || r.rowCount === 0) return null;
    return { offset: offset + r.rowCount, back: [...page.back, offset] };
  }
  if (page.back.length === 0) return null;
  return {
    offset: page.back[page.back.length - 1],
    back: page.back.slice(0, -1),
  };
}

/** 結果 r の行が、文の何行目から何行目か（1 から数える）。行が無ければ null。 */
export function rowRange(
  r: DbQueryResult,
): { from: number; to: number } | null {
  if (r.rowCount === 0) return null;
  const offset = r.offset ?? 0;
  return { from: offset + 1, to: offset + r.rowCount };
}

// ---- 読み込み中に押したページ送り ----
// ページを読んでいる間に押した向き（DB のタブの Dialog の f f f）は、捨てずに押した順に覚え、結果が来たら 1 つずつ送る。
// 読み込みの速さによらず、押した数だけ進むように。

/** 覚えておく向きの数の上限（押し続けても、要らない読み込みが長く続かないように）。 */
export const MAX_QUEUED_STEPS = 10;

/** 覚えている向き queued の後ろに step を足した列。上限に達していれば足さない。 */
export function queueStep(
  queued: readonly PageStep[],
  step: PageStep,
): readonly PageStep[] {
  return queued.length < MAX_QUEUED_STEPS ? [...queued, step] : queued;
}

/**
 * 結果が来たときに、覚えている向きの先頭を send で送り、まだ覚えておく残りを返す。
 * send が送れなかった（false。端のページ・ページ送りの無い結果）なら、残りも捨てて空を返す。
 */
export function sendQueued(
  queued: readonly PageStep[],
  send: (step: PageStep) => boolean,
): readonly PageStep[] {
  const [step, ...rest] = queued;
  if (step === undefined || !send(step)) return [];
  return rest;
}

// ---- 並べ替え（#377） ----
// 並べ替えはデータベースにさせる。結果を出した SQL を、ORDER BY を付けて包んで（ページ送りと同じ包み方）もう一度送るので、
// 全部の行が並び、2 ページ目以降もその順の続きになる。列は名前でなく位置で渡す（kisui serve が `ORDER BY 位置` にする。
// 引用符が要らず、PostgreSQL で同じ名前の列が 2 つあっても取り違えない。MySQL は名前の重なる列を断るので、その結果は wrappable が偽で並べ替えない）。

/** 並べ替えている列。column は 0 から数えた位置、desc は降順。 */
export interface DbSort {
  column: number;
  desc: boolean;
}

/** 結果 r を並べ替えられるか：包める文で、列がある。 */
export function sortable(r: DbQueryResult): boolean {
  return r.wrappable === true && r.columns.length > 0;
}

/**
 * 列 column の見出しを押したあとの並べ替え。今と違う列は昇順から、同じ列は「昇順 → 降順 → 並べ替えなし（null）」と進む。
 */
export function nextSort(
  cur: DbSort | undefined,
  column: number,
): DbSort | null {
  if (!cur || cur.column !== column) return { column, desc: false };
  return cur.desc ? null : { column, desc: true };
}

/** 見出しの aria-sort の値。 */
export function ariaSort(
  cur: DbSort | undefined,
  column: number,
): "ascending" | "descending" | undefined {
  if (!cur || cur.column !== column) return undefined;
  return cur.desc ? "descending" : "ascending";
}

// ---- 送る SQL と、その続き ----

/** 入力欄から実行した SQL の、先頭のページ。schema は、そのときのタブの既定のスキーマ（#378。無ければ付けない）。 */
export function firstPage(sql: string, schema?: string): DbPage {
  return { sql, back: [], ...(schema ? { schema } : {}) };
}

/** page の結果から、前のページの offset が back のページへ移ったときの DbPage（SQL・並べ替え・スキーマは引き継ぐ）。 */
export function steppedPage(page: DbPage, back: readonly number[]): DbPage {
  return { ...page, back };
}

/** page の結果を sort で並べ替え直したときの DbPage（先頭のページから。sort が無ければ元の順。SQL とスキーマは引き継ぐ）。 */
export function sortedPage(page: DbPage, sort: DbSort | undefined): DbPage {
  const { sort: _, ...rest } = page;
  return { ...rest, back: [], ...(sort ? { sort } : {}) };
}

/**
 * page を offset から読む db.query の引数のうち、ページの分（接続・queryId を除く）。rerun は、結果を出した SQL を読み直すだけの実行
 * （履歴に残さない）。スキーマ（#378）は、ログインが文ごとなので毎回付ける。
 */
export function pageParams(page: DbPage, offset: number, rerun: boolean) {
  return {
    sql: page.sql,
    ...(offset > 0 ? { offset } : {}),
    ...(page.sort
      ? {
          orderBy: page.sort.column + 1,
          ...(page.sort.desc ? { desc: true } : {}),
        }
      : {}),
    ...(page.schema ? { schema: page.schema } : {}),
    ...(rerun ? { rerun: true as const } : {}),
  };
}
