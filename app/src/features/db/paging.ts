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
