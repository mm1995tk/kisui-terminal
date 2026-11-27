import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  dropTarget,
  insertBefore,
  workspaceAt,
  type InsertItem,
} from "./tabMoveDrag.ts";

/** 高さ 40 の行を、上端 100 から隙間なく並べる。 */
const rows = (...keys: string[]): InsertItem[] =>
  keys.map((key, i) => ({ key, top: 100 + i * 40, bottom: 140 + i * 40 }));

describe("insertBefore（Workspace switcher の、タブの行のドラッグの入る位置。#308）", () => {
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

describe("workspaceAt（ポインタの下の、左の一覧のワークスペースの行）", () => {
  // 左の一覧は 0〜200 × 100〜180（2 行ぶん見えている）。3 行目は、一覧からはみ出して見えていない
  const listBox = { left: 0, right: 200, top: 100, bottom: 180 };
  const leftRows = ["g1", "g2", "g3"].map((gws, i) => ({
    gws,
    box: { left: 0, right: 200, top: 100 + i * 40, bottom: 140 + i * 40 },
  }));

  it("ポインタの下の行のワークスペース。行の無い所は undefined", () => {
    assert.equal(workspaceAt(50, 110, listBox, leftRows), "g1");
    assert.equal(workspaceAt(50, 170, listBox, leftRows), "g2");
    assert.equal(workspaceAt(300, 110, listBox, leftRows), undefined);
  });

  it("一覧からはみ出して見えていない行には当てない（一覧の下のボタンの位置など）", () => {
    assert.equal(workspaceAt(50, 200, listBox, leftRows), undefined);
  });
});

describe("dropTarget（いま離したら入る先）", () => {
  const right = { left: 220, right: 500, top: 100, bottom: 300 };
  const base = { right, tabs: rows("a", "b", "c"), self: "x", shown: "g2" };

  it("左のワークスペースの行の上なら、そのワークスペースの一番後ろ。線は出さない", () => {
    assert.deepEqual(dropTarget({ ...base, x: 50, y: 110, over: "g1" }), {
      gws: "g1",
      before: null,
      lineY: null,
    });
  });

  it("右の列の中なら、出しているワークスペースの、ポインタの位置。線はその行の上端", () => {
    assert.deepEqual(dropTarget({ ...base, x: 300, y: 150, over: undefined }), {
      gws: "g2",
      before: "b",
      lineY: 140,
    });
  });

  it("空のワークスペースの右の列にも落とせる（一番後ろ。線は列の上端）", () => {
    assert.deepEqual(
      dropTarget({ ...base, tabs: [], x: 300, y: 250, over: undefined }),
      { gws: "g2", before: null, lineY: 100 },
    );
  });

  it("線は、右の列の見えている範囲に収める（スクロールして、行が列の外にあるとき）", () => {
    const scrolled = rows("a", "b", "c").map((r) => ({
      ...r,
      top: r.top - 55,
      bottom: r.bottom - 55,
    }));
    assert.deepEqual(
      dropTarget({ ...base, tabs: scrolled, x: 300, y: 101, over: undefined }),
      { gws: "g2", before: "b", lineY: 100 },
    );
  });

  it("左の行の上でも右の列の中でもなければ、落とせない", () => {
    assert.equal(
      dropTarget({ ...base, x: 300, y: 400, over: undefined }),
      null,
    );
    assert.equal(
      dropTarget({
        ...base,
        shown: undefined,
        x: 300,
        y: 150,
        over: undefined,
      }),
      null,
    );
  });
});
