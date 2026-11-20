// クリップボードの履歴の窓（ClipboardHistoryDialog）の、DOM に触らない部分。
// 履歴を持つのは Tauri の側（clipboard_history.rs）。ここは一覧の見せ方を決める。

import type { KeyLike } from "../commands/guiKeys.ts";
import { isComposingKey } from "../commands/ime.ts";
import { listStep } from "../commands/placeKeys.ts";
import { T } from "../../i18n/index.ts";

/** kisui-terminal の外から開く履歴の窓のラベル（clipboard_popup.rs の LABEL と同じ）。 */
export const POPUP_LABEL = "clipboard-history";

/** 履歴の 1 件（clipboard_history.rs の Entry）。 */
export interface HistoryEntry {
  text: string;
  /** コピーした時刻（UNIX 時刻のミリ秒） */
  copiedAt: number;
}

/** 履歴を読む（新しいものが先頭）。本物は infrastructure/tauri/clipboardHistory.ts。 */
export type ListClipboardHistory = () => Promise<HistoryEntry[]>;

/**
 * kisui-terminal の外から開く履歴の窓（ui/utilities/clipboard）が、外（Tauri の殻。clipboard_popup.rs）に頼むこと。
 * 本物は infrastructure/tauri/clipboardHistory.ts。
 */
export interface ClipboardPopupOs {
  /** 窓が出し直された。返す関数で聞くのをやめる */
  onShown(h: () => void): Promise<() => void>;
  /** 窓を隠して、前のアプリに戻る */
  dismiss(): Promise<void>;
  /** クリップボードに書くだけ（窓は隠さない） */
  copy(text: string): Promise<void>;
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
  if (s < 60) return T("history.ago.now");
  const m = Math.floor(s / 60);
  if (m < 60) return T("history.ago.minutes", { n: m });
  return T("history.ago.hours", { n: Math.floor(m / 60) });
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

/** 履歴の窓で押したキーの動き。 */
export type HistoryKey =
  | { kind: "step"; step: 1 | -1 }
  /** 貼る（貼る先が無ければ、クリップボードに戻す） */
  | { kind: "choose" }
  /** OS のクリップボードに戻す */
  | { kind: "putBack" }
  | { kind: "help" };

/**
 * 履歴の窓（絞り込みの入力欄にキーがある）のキー。当たらなければ null（入力欄に字を打つ）。
 * ↓ ↑・Ctrl+J / Ctrl+K で選ぶ行を動かし（入力欄に字を打つので、j k は使えない）、Enter で貼り、Shift+Enter でクリップボードに戻す。
 * `?` は、helpOn（キーの一覧を出せる窓で、絞り込みが空）のときだけキーの一覧を出す（打っている途中の `?` は、探す字として入力欄に入れる。ブックマークの一覧と同じ）。
 * Esc は窓が受ける。
 */
export function historyKey(e: KeyLike, helpOn: boolean): HistoryKey | null {
  if (isComposingKey(e)) return null;
  if (e.key === "ArrowDown") return { kind: "step", step: 1 };
  if (e.key === "ArrowUp") return { kind: "step", step: -1 };
  const step = listStep(e);
  if (step !== 0) return { kind: "step", step };
  if (e.key === "Enter") return { kind: e.shiftKey ? "putBack" : "choose" };
  if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey && helpOn)
    return { kind: "help" };
  return null;
}

/** 一覧が空のときに出す文。entries は履歴（読み込み中は undefined）、failed は読めなかったか。 */
export function emptyMessage(
  failed: boolean,
  entries: readonly HistoryEntry[] | undefined,
): string {
  if (failed) return T("history.empty.failed");
  if (entries === undefined) return T("history.empty.loading");
  if (entries.length === 0) return T("history.empty.none");
  return T("history.empty.noMatch");
}
