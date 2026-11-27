// 内蔵ブラウザの「新しいタブのページ」（#238）の、キーと選びかた。DOM も Tauri も使わない（node --test で確かめられる）。
// Workspace switcher の、作るタブの種類（リーダーの n）の「ブラウザ」「シークレット」と、サイドバーの「+」のメニューの「ブラウザ」は、URL を聞かずにこのページのタブを開く。
// このページのタブは URL が空（NEW_TAB_URL）で、webview は作らず、画面（NewTabPage.tsx）が検索欄とブックマークを描く。
// 検索欄に打ったものを開くと、そのタブの URL がそのページになる（そこで初めて webview を作る）。

import { isComposingKey } from "../commands/ime.ts";
import type { KeyLike } from "../commands/guiKeys.ts";
import { listStep } from "../commands/placeKeys.ts";
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
 * 入力欄のキーの意味。`↓` `↑`・Ctrl+J / Ctrl+K はブックマークを選ぶ（検索欄から出入りする）、`Enter` は選んでいるブックマークか
 * 打ったものを開く、`Esc` は打ったものを消す。かな漢字変換中は何も受けない。
 */
export function newTabKey(e: KeyLike): NewTabKey | null {
  if (isComposingKey(e)) return null;
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
 * 選んでいる所を動かす。-1 は検索欄（ブックマークは選んでいない）、0 以上はブックマークの番号。
 * 検索欄より上へは行かず、最後のブックマークより下へも行かない（端で回らない）。ブックマークが無ければいつも検索欄。
 */
export function moveSelection(
  sel: number,
  step: 1 | -1,
  count: number,
): number {
  if (count <= 0) return -1;
  return Math.max(-1, Math.min(count - 1, sel + step));
}
