import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dropBefore, edgeScroll, layoutShifts } from "./drag.ts";

const items = [
  { key: "a", mid: 10 },
  { key: "b", mid: 30 },
  { key: "c", mid: 50 },
];

describe("dropBefore", () => {
  it("押している位置より下に真ん中がある、一番上の行の前", () => {
    assert.equal(dropBefore(items, "x", 0), "a");
    assert.equal(dropBefore(items, "x", 20), "b");
    assert.equal(dropBefore(items, "x", 40), "c");
  });
  it("どの行の真ん中より下なら、一番後ろ（null）", () => {
    assert.equal(dropBefore(items, "x", 80), null);
  });
  it("動かしている行は数えない", () => {
    assert.equal(dropBefore(items, "b", 20), "c");
    assert.equal(dropBefore(items, "c", 80), null);
  });
});

describe("edgeScroll", () => {
  it("端から離れていれば 0", () => {
    assert.equal(edgeScroll(200, 0, 400), 0);
  });
  it("上の端に寄ると負、下の端に寄ると正で、端に近いほど速い", () => {
    assert.ok(edgeScroll(20, 0, 400) < 0);
    assert.ok(edgeScroll(380, 0, 400) > 0);
    assert.ok(edgeScroll(0, 0, 400) < edgeScroll(20, 0, 400));
    assert.ok(edgeScroll(400, 0, 400) > edgeScroll(380, 0, 400));
  });
});

describe("layoutShifts", () => {
  // 高さ 20・行間 4 の 4 行
  const slots = [
    { key: "a", top: 0, height: 20 },
    { key: "b", top: 24, height: 20 },
    { key: "c", top: 48, height: 20 },
    { key: "d", top: 72, height: 20 },
  ];
  const obj = (m: Map<string, number>) => Object.fromEntries(m);

  it("元の場所のままなら、だれもよけない", () => {
    assert.deepEqual(obj(layoutShifts(slots, "b", "c")), { a: 0, c: 0, d: 0 });
  });
  it("下へ動かすと、間にある行が 1 行分（行間も）上へよける", () => {
    assert.deepEqual(obj(layoutShifts(slots, "a", "d")), {
      b: -24,
      c: -24,
      d: 0,
    });
    assert.deepEqual(obj(layoutShifts(slots, "a", null)), {
      b: -24,
      c: -24,
      d: -24,
    });
  });
  it("上へ動かすと、間にある行が 1 行分下へよける", () => {
    assert.deepEqual(obj(layoutShifts(slots, "d", "b")), {
      a: 0,
      b: 24,
      c: 24,
    });
    assert.deepEqual(obj(layoutShifts(slots, "c", "a")), {
      a: 24,
      b: 24,
      d: 0,
    });
  });
  it("一番後ろの行は、前の行との間を行間として使う", () => {
    assert.deepEqual(obj(layoutShifts(slots, "d", "a")), {
      a: 24,
      b: 24,
      c: 24,
    });
  });
  it("動かす行しか無ければ何も返さない", () => {
    assert.equal(layoutShifts([slots[0]!], "a", null).size, 0);
  });
});
