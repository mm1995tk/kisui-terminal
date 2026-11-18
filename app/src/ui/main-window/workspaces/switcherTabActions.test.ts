import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { nextTabAfterClose } from "./switcherTabActions.ts";

const items = [{ key: "a" }, { key: "b" }, { key: "c" }];

describe("タブを閉じたあとに選ぶタブ", () => {
  it("隣（下）のタブを選び、一番下なら前のタブを選ぶ", () => {
    assert.equal(nextTabAfterClose(items, "a"), "b");
    assert.equal(nextTabAfterClose(items, "b"), "c");
    assert.equal(nextTabAfterClose(items, "c"), "b");
  });

  it("ほかにタブが無いか、閉じるタブが無ければ選ばない", () => {
    assert.equal(nextTabAfterClose([{ key: "a" }], "a"), undefined);
    assert.equal(nextTabAfterClose(items, "z"), undefined);
  });
});
