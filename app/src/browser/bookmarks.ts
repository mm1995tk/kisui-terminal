// 内蔵ブラウザのブックマーク（#205）。すべてのワークスペースで共有し、殻がデータのフォルダの `browser-bookmarks.json` に覚える
// （src-tauri/src/bookmarks.rs。形は Bookmark と同じ）。並びは新しく足したものが先。同じ URL は 1 つだけ持つ。
// リーダーの `o b` で今のページを足し、`o B` で一覧のダイアログ（BookmarkDialog.tsx）を開く。
// DOM も Tauri も使わない（node --test で確かめられる）。

import type { KeyLike } from "../guiKeys.ts";
import { listStep } from "../placeKeys.ts";

/** ブックマーク 1 つ。 */
export interface Bookmark {
  url: string;
  /** ページの題（分からなければ空） */
  title: string;
  /** Chrome から読んだものなら "chrome"（#239。kisui-terminal 自身のものは付けない。覚えるファイルには入らない） */
  source?: "chrome";
}

/** 覚えるブックマークの数の上限（bookmarks.rs の MAX_BOOKMARKS と同じ）。 */
export const MAX_BOOKMARKS = 5000;
/** 題の長さの上限（bookmarks.rs と同じ。バイトではなく字で数え、短めに切る）。 */
const MAX_TITLE = 300;

/**
 * ブックマークを足す。同じ URL があれば、それを除いてから先頭に足す（題は新しいものにする）。
 * 上限を超えたら、古いもの（後ろ）から捨てる。
 */
export function addBookmark(
  list: readonly Bookmark[],
  b: Bookmark,
): Bookmark[] {
  const title = b.title.trim().slice(0, MAX_TITLE);
  return [{ url: b.url, title }, ...list.filter((x) => x.url !== b.url)].slice(
    0,
    MAX_BOOKMARKS,
  );
}

/** URL の同じブックマークを消す。 */
export function removeBookmark(
  list: readonly Bookmark[],
  url: string,
): Bookmark[] {
  return list.filter((x) => x.url !== url);
}

/** 絞り込む。空白で区切った語がすべて、題か URL に（大文字小文字を問わず）含まれるもの。並びは変えない。 */
export function filterBookmarks(
  list: readonly Bookmark[],
  query: string,
): Bookmark[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...list];
  return list.filter((b) => {
    const t = `${b.title}\n${b.url}`.toLowerCase();
    return words.every((w) => t.includes(w));
  });
}

/** 殻が読んだもの。形の違うもの・同じ URL の 2 つ目は捨てる。 */
export function fromLoaded(v: unknown): Bookmark[] {
  if (!Array.isArray(v)) return [];
  const out: Bookmark[] = [];
  for (const b of v as unknown[]) {
    if (typeof b !== "object" || b === null) continue;
    const { url, title } = b as Partial<Bookmark>;
    if (typeof url !== "string" || out.some((x) => x.url === url)) continue;
    out.push({ url, title: typeof title === "string" ? title : "" });
  }
  return out.slice(0, MAX_BOOKMARKS);
}

/** ブックマークの一覧のダイアログで押したキーの動き。 */
export type BookmarkKey =
  | { kind: "step"; step: 1 | -1 }
  | { kind: "open" }
  | { kind: "delete" }
  | { kind: "help" };

/**
 * ダイアログ（絞り込みの入力欄にキーがある）のキー。当たらなければ null（入力欄に字を打つ）。
 * ↓ ↑・Ctrl+J / Ctrl+K で選ぶ行を動かし、Enter で開き、Ctrl+D で消す。`?` は、絞り込みが空のときだけキーの一覧を出す
 * （打っている途中の `?` は、URL の `?` を探す字として入力欄に入れる）。Esc は ModalCard が受ける。
 */
export function bookmarkKey(
  e: KeyLike,
  queryEmpty: boolean,
): BookmarkKey | null {
  if (e.isComposing) return null;
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  if (plain && !e.shiftKey && e.key === "ArrowDown")
    return { kind: "step", step: 1 };
  if (plain && !e.shiftKey && e.key === "ArrowUp")
    return { kind: "step", step: -1 };
  const step = listStep(e);
  if (step !== 0) return { kind: "step", step };
  if (plain && !e.shiftKey && e.key === "Enter") return { kind: "open" };
  if (
    e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey &&
    e.key.toLowerCase() === "d"
  )
    return { kind: "delete" };
  if (plain && e.key === "?" && queryEmpty) return { kind: "help" };
  return null;
}

/** ブックマークの行の title（マウスを載せたときの文）。URL。 */
export function bookmarkTitle(b: Bookmark): string {
  return b.url;
}

/** Chrome のブックマークを読めなかった理由（#265）。殻の `ChromeProblem`。 */
export type ChromeProblem = {
  path: string;
  reason: string;
  needsPermission: boolean;
};

/** 殻が返した Chrome のブックマークの読み込みから、読めなかった理由を取り出す。無い・形が違うときは undefined。 */
export function chromeProblemFromLoaded(v: unknown): ChromeProblem | undefined {
  if (typeof v !== "object" || v === null || !("problem" in v)) return;
  const p = (v as { problem: unknown }).problem;
  if (typeof p !== "object" || p === null) return;
  const { path, reason, needsPermission } = p as Record<string, unknown>;
  if (typeof path !== "string" || typeof reason !== "string") return;
  return { path, reason, needsPermission: needsPermission === true };
}

/** 同じ理由を何度も知らせないための印（読もうとしたファイルと理由が同じなら同じ）。 */
export function chromeProblemKey(p: ChromeProblem): string {
  return `${p.path}\n${p.reason}\n${p.needsPermission}`;
}
