import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TabItem } from "../../../features/workspaces/rows.ts";
import {
  type Hold,
  dropTarget,
  holdItems,
  startPos,
  stepPos,
} from "./switcherHold.ts";

const tab = (key: string): TabItem => ({ key, title: key }) as TabItem;
const items = (...keys: string[]) => keys.map(tab);
// ワークスペース "a" の b（2 番目）をつかんだ
const hold: Hold = { tab: tab("b"), from: "a", index: 1 };

describe("つかんだタブの入る位置", () => {
  it("別のワークスペースへ移ると一番後ろ、つかんだときのワークスペースへ戻ると元の位置", () => {
    assert.equal(startPos(hold, "z", items("x", "y")), 2);
    assert.equal(startPos(hold, "z", items()), 0);
    assert.equal(startPos(hold, "a", items("a1", "b", "c")), 1);
  });

  it("1 つずつ動かし、端では止まる", () => {
    assert.equal(stepPos(1, "next", 3), 2);
    assert.equal(stepPos(3, "next", 3), 3);
    assert.equal(stepPos(1, "prev", 3), 0);
    assert.equal(stepPos(0, "prev", 3), 0);
  });

  it("右の列には、つかんだタブを入る位置に出す", () => {
    const keys = (xs: TabItem[]) => xs.map((t) => t.key);
    assert.deepEqual(keys(holdItems(items("a1", "b", "c"), hold, 1)), [
      "a1",
      "b",
      "c",
    ]);
    assert.deepEqual(keys(holdItems(items("a1", "b", "c"), hold, 2)), [
      "a1",
      "c",
      "b",
    ]);
    assert.deepEqual(keys(holdItems(items("x", "y"), hold, 2)), [
      "x",
      "y",
      "b",
    ]);
    assert.deepEqual(keys(holdItems(items(), hold, 0)), ["b"]);
  });
});

describe("落とす先", () => {
  it("別のワークスペースの一番後ろへ", () => {
    assert.deepEqual(dropTarget(hold, "z", items("x", "y"), 2), {
      gws: "z",
      before: null,
    });
  });

  it("入る位置のタブの前へ（j → l → k）", () => {
    assert.deepEqual(dropTarget(hold, "z", items("x", "y"), 1), {
      gws: "z",
      before: "y",
    });
    assert.deepEqual(dropTarget(hold, "z", items("x", "y"), 0), {
      gws: "z",
      before: "x",
    });
  });

  it("つかんだときのワークスペースの元の位置のままなら、何も変えない", () => {
    assert.equal(dropTarget(hold, "a", items("a1", "b", "c"), 1), null);
  });

  it("つかんだときのワークスペースの中でも、位置が変わっていれば動かす", () => {
    assert.deepEqual(dropTarget(hold, "a", items("a1", "b", "c"), 2), {
      gws: "a",
      before: null,
    });
    assert.deepEqual(dropTarget(hold, "a", items("a1", "b", "c"), 0), {
      gws: "a",
      before: "a1",
    });
  });
});
