// DB のタブの、接続ごとのクエリの履歴（#349）の、画面に依存しない部分。
// 履歴を持つのは、接続を書いたマシンの kisui serve（db.history。#346）。ここは一覧の見せ方を決める。

import type { DbHistoryEntry } from "../../infrastructure/rpc/protocol.ts";

/** 履歴の 1 行に出す SQL の字数の上限。 */
export const HISTORY_PREVIEW_MAX = 160;

/** 1 行の見出し：空白と改行を 1 つの空白にたたみ、長ければ切って … を付ける。 */
export function sqlPreview(sql: string, max = HISTORY_PREVIEW_MAX): string {
  const one = sql.replace(/\s+/g, " ").trim();
  const chars = [...one];
  return chars.length <= max ? one : `${chars.slice(0, max).join("")}…`;
}

/** 打った文字で絞り込む（大文字小文字を区別せず、空白で区切った語がすべて含まれる SQL）。順は変えない。 */
export function filterHistory(
  entries: readonly DbHistoryEntry[],
  query: string,
): DbHistoryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...entries];
  return entries.filter((e) => {
    const s = e.sql.toLowerCase();
    return words.every((w) => s.includes(w));
  });
}

/** 送った時刻（UTC の RFC 3339）を、この端末の時刻の `年-月-日 時:分` にする。読めなければそのまま。 */
export function atText(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
