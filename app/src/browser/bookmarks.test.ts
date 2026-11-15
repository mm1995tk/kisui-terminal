import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PLACE_KEYS } from "../placeKeys.ts";
import { chromeTreeFromLoaded } from "./bookmarkTree.ts";
import {
  addBookmark,
  bookmarkKey,
  chromeProblemFromLoaded,
  chromeProblemKey,
  filterBookmarks,
  fromLoaded,
  MAX_BOOKMARKS,
  removeBookmark,
  type Bookmark,
} from "./bookmarks.ts";

const ev = (key: string, mods = "", isComposing = false) => ({
  key,
  ctrlKey: mods.includes("c"),
  shiftKey: mods.includes("s"),
  altKey: mods.includes("a"),
  metaKey: mods.includes("m"),
  isComposing,
});

const A: Bookmark = { url: "https://a.example/", title: "Alpha" };
const B: Bookmark = { url: "https://b.example/docs", title: "Beta docs" };

describe("ブックマーク（#205）", () => {
  it("足したものは先頭に入る。同じ URL は 1 つにし、題を新しくして先頭へ", () => {
    let l = addBookmark([], A);
    l = addBookmark(l, B);
    assert.deepEqual(
      l.map((b) => b.url),
      [B.url, A.url],
    );
    l = addBookmark(l, { url: A.url, title: "  Alpha 2 " });
    assert.deepEqual(l, [{ url: A.url, title: "Alpha 2" }, B]);
  });

  it("上限を超えたら古いものから捨てる", () => {
    const many = Array.from({ length: MAX_BOOKMARKS }, (_, i) => ({
      url: `https://e.example/${i}`,
      title: "",
    }));
    const l = addBookmark(many, A);
    assert.equal(l.length, MAX_BOOKMARKS);
    assert.equal(l[0].url, A.url);
    assert.ok(
      !l.some((b) => b.url === `https://e.example/${MAX_BOOKMARKS - 1}`),
    );
  });

  it("消すのは URL の同じもの", () => {
    assert.deepEqual(removeBookmark([A, B], A.url), [B]);
    assert.deepEqual(removeBookmark([A, B], "https://c.example/"), [A, B]);
  });

  it("絞り込みは、空白で区切った語がすべて題か URL に含まれるもの（大文字小文字を問わない）", () => {
    assert.deepEqual(filterBookmarks([A, B], ""), [A, B]);
    assert.deepEqual(filterBookmarks([A, B], "beta"), [B]);
    assert.deepEqual(filterBookmarks([A, B], "B.EXAMPLE docs"), [B]);
    assert.deepEqual(filterBookmarks([A, B], "alpha docs"), []);
  });

  it("殻が読んだものは、形の違うもの・同じ URL の 2 つ目を捨てる", () => {
    assert.deepEqual(fromLoaded(null), []);
    assert.deepEqual(
      fromLoaded([
        A,
        { url: 1 },
        "x",
        { url: A.url, title: "dup" },
        { url: B.url },
      ]),
      [A, { url: B.url, title: "" }],
    );
  });
});

describe("ブックマークの一覧のキー（bookmarkKey）", () => {
  it("↓ ↑ と Ctrl+J / Ctrl+K で選ぶ行を動かす", () => {
    assert.deepEqual(bookmarkKey(ev("ArrowDown"), true), {
      kind: "step",
      step: 1,
    });
    assert.deepEqual(bookmarkKey(ev("ArrowUp"), true), {
      kind: "step",
      step: -1,
    });
    assert.deepEqual(bookmarkKey(ev("j", "c"), false), {
      kind: "step",
      step: 1,
    });
    assert.deepEqual(bookmarkKey(ev("k", "c"), false), {
      kind: "step",
      step: -1,
    });
  });

  it("Enter で開き、Ctrl+D で消す", () => {
    assert.deepEqual(bookmarkKey(ev("Enter"), false), { kind: "open" });
    assert.deepEqual(bookmarkKey(ev("d", "c"), false), { kind: "delete" });
    assert.deepEqual(bookmarkKey(ev("D", "c"), false), { kind: "delete" });
    // 修飾キーの違うものは受けない（Ctrl+Shift+D は右に分ける近道）
    assert.equal(bookmarkKey(ev("D", "cs"), false), null);
    assert.equal(bookmarkKey(ev("d", "m"), false), null);
    assert.equal(bookmarkKey(ev("Enter", "m"), false), null);
  });

  it("? は絞り込みが空のときだけキーの一覧。打っている途中の ? は入力欄の字", () => {
    assert.deepEqual(bookmarkKey(ev("?", "s"), true), { kind: "help" });
    assert.equal(bookmarkKey(ev("?", "s"), false), null);
  });

  it("字と、変換中のキーは入力欄に渡す", () => {
    for (const k of ["a", "j", "d", "/"])
      assert.equal(bookmarkKey(ev(k), true), null, k);
    assert.equal(bookmarkKey(ev("Enter", "", true), false), null);
  });

  it("`?` の一覧の表のキーは、どれも判定が受ける", () => {
    for (const r of PLACE_KEYS.bookmarks.rows)
      for (const p of r.probes)
        assert.notEqual(
          bookmarkKey(ev(p, p === "?" ? "s" : ""), true),
          null,
          `${r.keys}: ${p}`,
        );
  });
});

it("Chrome のブックマークの読み込みから、ブックマークと読めなかった理由を取り出す（#265）", () => {
  const ok = {
    roots: [
      {
        type: "folder",
        name: "Bookmarks bar",
        children: [{ type: "url", url: "https://a.example/", title: "A" }],
      },
    ],
    problem: null,
  };
  assert.equal(chromeTreeFromLoaded(ok).length, 1);
  assert.equal(chromeProblemFromLoaded(ok), undefined);
  assert.equal(chromeProblemFromLoaded([]), undefined);
  const denied = {
    roots: [],
    problem: {
      path: "/h/Bookmarks",
      reason: "Operation not permitted (os error 1)",
      needsPermission: true,
    },
  };
  assert.equal(chromeTreeFromLoaded(denied).length, 0);
  const p = chromeProblemFromLoaded(denied);
  assert.deepEqual(p, denied.problem);
  assert.equal(chromeProblemKey(p!), chromeProblemKey({ ...denied.problem }));
  assert.notEqual(
    chromeProblemKey(p!),
    chromeProblemKey({ ...denied.problem, reason: "invalid JSON" }),
  );
  assert.equal(chromeProblemFromLoaded({ problem: { path: 1 } }), undefined);
});
