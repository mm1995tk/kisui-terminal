import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dropBefore } from "./drag.ts";

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
