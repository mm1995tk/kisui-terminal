// 内蔵ブラウザの「新しいタブのページ」（#238）の、キーと選びかた。DOM も Tauri も使わない（node --test で確かめられる）。
// リーダーの o n・o N と、サイドバーの「+」のメニューの「ブラウザ」は、URL を聞かずにこのページのタブを開く。
// このページのタブは URL が空（NEW_TAB_URL）で、webview は作らず、画面（NewTabPage.tsx）が検索窓とブックマークを描く。
// 検索窓に打ったものを開くと、そのタブの URL がそのページになる（そこで初めて webview を作る）。

import type { KeyLike } from "../guiKeys.ts";
import { listStep } from "../placeKeys.ts";
import type { BrowserTab } from "./tabs.ts";

/** 新しいタブのページのタブの URL（空。ページを開くと、その URL に替わる）。 */
export const NEW_TAB_URL = "";

/** 新しいタブのページか（まだ何も開いていないタブ）。 */
export function isNewTab(t: Pick<BrowserTab, "url">): boolean {
  return t.url === NEW_TAB_URL;
}

/** 新しいタブのページの入力欄が受けるキー。 */
export type NewTabKey =
  { kind: "step"; step: 1 | -1 } | { kind: "enter" } | { kind: "cancel" };

/**
 * 入力欄のキーの意味。`↓` `↑`・Ctrl+J / Ctrl+K はブックマークを選ぶ（検索窓から出入りする）、`Enter` は選んでいるブックマークか
 * 打ったものを開く、`Esc` は打ったものを消す。かな漢字変換中は何も受けない。
 */
export function newTabKey(e: KeyLike): NewTabKey | null {
  if (e.isComposing) return null;
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  if (plain && e.key === "ArrowDown") return { kind: "step", step: 1 };
  if (plain && e.key === "ArrowUp") return { kind: "step", step: -1 };
  const step = listStep(e);
  if (step !== 0) return { kind: "step", step };
  if (plain && e.key === "Enter") return { kind: "enter" };
  if (plain && e.key === "Escape") return { kind: "cancel" };
  return null;
}

/**
 * 選んでいる所を動かす。-1 は検索窓（ブックマークは選んでいない）、0 以上はブックマークの番号。
 * 検索窓より上へは行かず、最後のブックマークより下へも行かない（端で回らない）。ブックマークが無ければいつも検索窓。
 */
export function moveSelection(
  sel: number,
  step: 1 | -1,
  count: number,
): number {
  if (count <= 0) return -1;
  return Math.max(-1, Math.min(count - 1, sel + step));
}
