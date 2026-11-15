import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dropBefore, dropPlan, edgeScroll } from "./drag.ts";

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

describe("dropPlan", () => {
  it("行の前に落とすなら、その行の上に印を付ける", () => {
    assert.deepEqual(dropPlan(items, "x", 20), {
      before: "b",
      target: "b",
      at: "before",
    });
  });
  it("一番後ろに落とすなら、一番後ろの行（動かす行を除く）の下に印を付ける", () => {
    assert.deepEqual(dropPlan(items, "c", 80), {
      before: null,
      target: "b",
      at: "after",
    });
  });
  it("動かす行しか無ければ、印を付ける行が無い", () => {
    assert.deepEqual(dropPlan([{ key: "a", mid: 10 }], "a", 0), {
      before: null,
      target: null,
      at: "after",
    });
  });
});
