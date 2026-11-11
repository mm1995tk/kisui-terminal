// クリップボードの履歴の窓（ClipboardHistoryDialog）の、DOM に触らない部分。
// 履歴を持つのは Tauri の側（clipboard_history.rs）。ここは開くキーと、一覧の見せ方を決める。

import type { KeyLike } from "./guiKeys.ts";

/** kisui-terminal の外から開く履歴の窓のラベル（clipboard_popup.rs の LABEL と同じ）。 */
export const POPUP_LABEL = "clipboard-history";

/** 履歴の 1 件（clipboard_history.rs の Entry）。 */
export interface HistoryEntry {
  text: string;
  /** コピーした時刻（UNIX 時刻のミリ秒） */
  copiedAt: number;
}

/**
 * 履歴の窓を開くキー。Mac は Cmd+Shift+H、そのほかは Ctrl+Shift+H（History の H）。
 * Ctrl+Shift+V は端末の貼り付けなので避けた。
 */
export function isHistoryKey(e: KeyLike, mac: boolean): boolean {
  if (e.isComposing || !e.shiftKey || e.altKey) return false;
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod) return false;
  return e.key.toLowerCase() === "h" || e.code === "KeyH";
}

/** 一覧の 1 行に出す文字の最大の長さ。 */
export const PREVIEW_MAX = 120;

/** 1 行の見出し。空白と改行を 1 つの空白にたたみ、長ければ切って … を付ける。 */
export function preview(text: string, max = PREVIEW_MAX): string {
  const one = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(one);
  if (chars.length <= max) return one;
  return chars.slice(0, max).join("") + "…";
}

/** コピーしてからの時間の見せ方（たとえば「3 分前」）。 */
export function ago(copiedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - copiedAt) / 1000));
  if (s < 60) return "たった今";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分前`;
  return `${Math.floor(m / 60)} 時間前`;
}

/** 打った文字で絞り込む（大文字小文字を区別せず、空白で区切った語がすべて含まれるもの）。順は変えない。 */
export function filterEntries(
  entries: readonly HistoryEntry[],
  query: string,
): HistoryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...entries];
  return entries.filter((e) => {
    const t = e.text.toLowerCase();
    return words.every((w) => t.includes(w));
  });
}

/** 選んでいる行を step だけ動かす（端で止まる）。行が無ければ 0。 */
export function moveSelection(cur: number, step: number, len: number): number {
  if (len <= 0) return 0;
  return Math.min(len - 1, Math.max(0, cur + step));
}

/** 一覧が空のときに出す文。entries は履歴（読み込み中は undefined）、failed は読めなかったか。 */
export function emptyMessage(
  failed: boolean,
  entries: readonly HistoryEntry[] | undefined,
): string {
  if (failed) return "履歴を読めませんでした";
  if (entries === undefined) return "読み込んでいます";
  if (entries.length === 0) return "履歴はまだありません";
  return "当てはまるものがありません";
}
