import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Bookmark } from "./bookmarks.ts";
import {
  bookmarkRows,
  chromeTreeFromLoaded,
  countChrome,
  toggleFolder,
  type BookmarkRow,
} from "./bookmarkTree.ts";

const url = (u: string, t: string) => ({ type: "url", url: u, title: t });
const folder = (name: string, children: unknown[]) => ({
  type: "folder",
  name,
  children,
});

// Chrome のファイルと同じ形（フォルダとブックマークが混ざった並び）
const loaded = {
  roots: [
    folder("Bookmarks bar", [
      url("https://a.example/", "Alpha"),
      folder("Dev", [
        url("https://b.example/", "Beta"),
        folder("Deep", [url("https://d.example/", "Delta")]),
      ]),
      url("https://c.example/", "Gamma"),
    ]),
    folder("Other bookmarks", [url("https://e.example/", "Epsilon")]),
    folder("Mobile bookmarks", []),
  ],
};

const label = (r: BookmarkRow) =>
  r.kind === "folder"
    ? `${"-".repeat(r.depth)}${r.open ? "v" : ">"}${r.name}`
    : `${"-".repeat(r.depth)}${r.bookmark.title}`;
const rows = (
  own: Bookmark[] | undefined,
  flipped: string[] = [],
  query = "",
) =>
  bookmarkRows(own, chromeTreeFromLoaded(loaded), new Set(flipped), query).map(
    label,
  );

describe("Chrome のブックマークの木（#275）", () => {
  it("殻が返した木を、入れ子と並びのまま読み、形の違うものは捨てる", () => {
    const t = chromeTreeFromLoaded(loaded);
    assert.equal(t.length, 3);
    assert.equal(countChrome(t), 5);
    const bar = t[0];
    assert.equal(bar.kind, "folder");
    assert.deepEqual(bar.kind === "folder" && bar.children.map((c) => c.kind), [
      "bookmark",
      "folder",
      "bookmark",
    ]);
    assert.deepEqual(chromeTreeFromLoaded("x"), []);
    assert.deepEqual(
      chromeTreeFromLoaded({ roots: [null, 1, { type: "url" }] }),
      [],
    );
    const b = chromeTreeFromLoaded({
      roots: [url("https://x.example/", "X")],
    })[0];
    assert.deepEqual(b.kind === "bookmark" && b.bookmark, {
      url: "https://x.example/",
      title: "X",
      source: "chrome",
    });
  });

  it("根は開き、その下のフォルダは閉じている。空の根は出さない", () => {
    assert.deepEqual(rows(undefined), [
      "vBookmarks bar",
      "-Alpha",
      "->Dev",
      "-Gamma",
      "vOther bookmarks",
      "-Epsilon",
    ]);
  });

  it("開け閉めを逆にする（根も、入れ子の中も）", () => {
    assert.deepEqual(rows(undefined, ["0/1"]), [
      "vBookmarks bar",
      "-Alpha",
      "-vDev",
      "--Beta",
      "-->Deep",
      "-Gamma",
      "vOther bookmarks",
      "-Epsilon",
    ]);
    assert.deepEqual(rows(undefined, ["0", "1"]), [
      ">Bookmarks bar",
      ">Other bookmarks",
    ]);
    const s = toggleFolder(new Set(), "0/1");
    assert.deepEqual([...s], ["0/1"]);
    assert.deepEqual([...toggleFolder(s, "0/1")], []);
  });

  it("自身のブックマークが先に平らに並び、同じ URL の Chrome のものは出さない", () => {
    const own: Bookmark[] = [
      { url: "https://a.example/", title: "Mine" },
      { url: "https://z.example/", title: "Zed" },
    ];
    assert.deepEqual(rows(own), [
      "Mine",
      "Zed",
      "vBookmarks bar",
      "->Dev",
      "-Gamma",
      "vOther bookmarks",
      "-Epsilon",
    ]);
  });

  it("絞り込むと、当たったブックマークと、入っているフォルダ（開いた状態）だけを出す", () => {
    assert.deepEqual(rows(undefined, [], "delta"), [
      "vBookmarks bar",
      "-vDev",
      "--vDeep",
      "---Delta",
    ]);
    assert.deepEqual(
      rows(undefined, [], "example"),
      rows(undefined, ["0/1", "0/1/1"]),
    );
    assert.deepEqual(rows(undefined, [], "nothing"), []);
    assert.deepEqual(rows(undefined, [], "  "), rows(undefined));
  });

  it("読み込み中は何も出ない。木だけ・自身だけでも出る", () => {
    assert.deepEqual(bookmarkRows(undefined, undefined, new Set(), ""), []);
    assert.deepEqual(
      bookmarkRows(
        [{ url: "https://m.example/", title: "M" }],
        undefined,
        new Set(),
        "",
      ).map(label),
      ["M"],
    );
  });
});
