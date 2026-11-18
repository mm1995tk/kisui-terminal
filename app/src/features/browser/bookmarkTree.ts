// Chrome のブックマークを、Chrome と同じフォルダの入れ子で出すための木と行（#275）。DOM も Tauri も使わない（node --test で確かめられる）。
// 殻（src-tauri/src/bookmarks.rs の ChromeNode）が、根のフォルダ（ブックマークバー・その他のブックマーク・モバイル）を、
// Chrome のファイルと同じ入れ子と並びのまま返す。一覧のダイアログ（BookmarkDialog.tsx）と新しいタブのページ（NewTabPage.tsx）は、
// 開け閉めの状態から「いま見える行」を bookmarkRows で作り、その行の上で選びを動かす。

import { filterBookmarks, type Bookmark } from "./bookmarks.ts";

/** Chrome のブックマークの木の節。 */
export type ChromeNode =
  | { kind: "folder"; name: string; children: ChromeNode[] }
  | { kind: "bookmark"; bookmark: Bookmark };

/** 一覧の 1 行。key は、根から数えた番号の道（`0/2/1`。同じ名前のフォルダがあっても区別できる）。 */
export type BookmarkRow =
  | { kind: "folder"; key: string; name: string; depth: number; open: boolean }
  | { kind: "bookmark"; bookmark: Bookmark; depth: number };

/** 木の深さの上限（殻の MAX_DEPTH と同じ。形の違うものが深くても、たどりきれるように） */
const MAX_DEPTH = 32;

function nodeFromLoaded(v: unknown, depth: number): ChromeNode | undefined {
  if (typeof v !== "object" || v === null || depth > MAX_DEPTH) return;
  const n = v as Record<string, unknown>;
  if (n.type === "url") {
    if (typeof n.url !== "string") return;
    return {
      kind: "bookmark",
      bookmark: {
        url: n.url,
        title: typeof n.title === "string" ? n.title : "",
        source: "chrome",
      },
    };
  }
  if (n.type === "folder") {
    const children = Array.isArray(n.children)
      ? (n.children as unknown[]).flatMap(
          (c) => nodeFromLoaded(c, depth + 1) ?? [],
        )
      : [];
    return {
      kind: "folder",
      name: typeof n.name === "string" ? n.name : "",
      children,
    };
  }
}

/** 殻が読んだ Chrome のブックマーク（`{ roots, problem }` の形）の、根のフォルダ。形の違うものは捨てる。 */
export function chromeTreeFromLoaded(v: unknown): ChromeNode[] {
  const roots =
    typeof v === "object" && v !== null
      ? (v as { roots?: unknown }).roots
      : undefined;
  if (!Array.isArray(roots)) return [];
  return (roots as unknown[]).flatMap((r) => nodeFromLoaded(r, 0) ?? []);
}

/** 木にあるブックマークの数。 */
export function countChrome(nodes: readonly ChromeNode[]): number {
  let n = 0;
  for (const x of nodes)
    n += x.kind === "bookmark" ? 1 : countChrome(x.children);
  return n;
}

/**
 * いま見える行。kisui-terminal 自身のブックマークが先（平ら。深さ 0）、そのあとに Chrome の木。
 * フォルダは、根だけ最初から開いていて、flipped に入っている key のものは逆（開いていれば閉じ、閉じていれば開く）。
 * Chrome のブックマークのうち、自身のものと同じ URL のものは出さない（同じ URL は自身のものを残す。#239 からの決まり）。
 * 絞り込む（query が空でない）ときは、題か URL が当たったブックマークと、それが入っているフォルダ（すべて開いた状態）だけを出す。
 */
export function bookmarkRows(
  own: readonly Bookmark[] | undefined,
  chrome: readonly ChromeNode[] | undefined,
  flipped: ReadonlySet<string>,
  query: string,
): BookmarkRow[] {
  const rows: BookmarkRow[] = filterBookmarks(own ?? [], query).map((b) => ({
    kind: "bookmark",
    bookmark: b,
    depth: 0,
  }));
  const ownUrls = new Set((own ?? []).map((b) => b.url));
  const filtering = query.trim() !== "";
  // 絞り込みに当たる URL の集まり（木のブックマークだけを filterBookmarks に通す）
  const hits = filtering
    ? new Set(
        filterBookmarks(
          leaves(chrome ?? []).filter((b) => !ownUrls.has(b.url)),
          query,
        ),
      )
    : undefined;
  function walk(nodes: readonly ChromeNode[], depth: number, path: string) {
    nodes.forEach((n, i) => {
      if (n.kind === "bookmark") {
        if (ownUrls.has(n.bookmark.url)) return;
        if (hits && !hits.has(n.bookmark)) return;
        rows.push({ kind: "bookmark", bookmark: n.bookmark, depth });
        return;
      }
      const key = path === "" ? String(i) : `${path}/${i}`;
      const at = rows.length;
      // 子は、親の行の後ろに足す
      const open = filtering || (depth === 0) !== flipped.has(key);
      rows.push({ kind: "folder", key, name: n.name, depth, open });
      if (open) {
        walk(n.children, depth + 1, key);
      }
      // 子の行が 1 つも足されなかった開いたフォルダは外す（絞り込みで当たるものが無い・根の中身がすべて自身のものと同じ URL）。
      // 根は、中が空なら閉じていても出さない（モバイルのブックマークが無い、など）
      if (
        (open && rows.length === at + 1 && (filtering || depth === 0)) ||
        (!filtering && depth === 0 && n.children.length === 0)
      )
        rows.pop();
    });
  }
  walk(chrome ?? [], 0, "");
  return rows;
}

function leaves(nodes: readonly ChromeNode[]): Bookmark[] {
  return nodes.flatMap((n) =>
    n.kind === "bookmark" ? [n.bookmark] : leaves(n.children),
  );
}

/** key のフォルダの開け閉めを逆にした flipped を返す（渡したものは変えない）。 */
export function toggleFolder(
  flipped: ReadonlySet<string>,
  key: string,
): Set<string> {
  const next = new Set(flipped);
  if (!next.delete(key)) next.add(key);
  return next;
}
