import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { insertBefore, type InsertItem } from "./tabMoveDrag.ts";

/** 高さ 40 の行を、上端 100 から隙間なく並べる。 */
const rows = (...keys: string[]): InsertItem[] =>
  keys.map((key, i) => ({ key, top: 100 + i * 40, bottom: 140 + i * 40 }));

describe("insertBefore（ワークスペースの窓の、タブの行のドラッグの入る位置。#308）", () => {
  it("行の真ん中より上なら、その行の前。線はその行の上端", () => {
    assert.deepEqual(insertBefore(rows("a", "b", "c"), "x", 110, 0), {
      before: "a",
      y: 100,
    });
    assert.deepEqual(insertBefore(rows("a", "b", "c"), "x", 150, 0), {
      before: "b",
      y: 140,
    });
  });

  it("どの行の真ん中よりも下なら一番後ろ。線は最後の行の下端", () => {
    assert.deepEqual(insertBefore(rows("a", "b", "c"), "x", 205, 0), {
      before: null,
      y: 220,
    });
  });

  it("つかんだ行は数えない（同じワークスペースの中で動かすとき）", () => {
    assert.deepEqual(insertBefore(rows("a", "b", "c"), "a", 110, 0), {
      before: "b",
      y: 140,
    });
    assert.deepEqual(insertBefore(rows("a", "b", "c"), "c", 300, 0), {
      before: null,
      y: 180,
    });
  });

  it("行が無い（空のワークスペース）なら一番後ろ。線は列の上端", () => {
    assert.deepEqual(insertBefore([], "x", 500, 64), { before: null, y: 64 });
    assert.deepEqual(insertBefore(rows("x"), "x", 500, 64), {
      before: null,
      y: 64,
    });
  });
});
