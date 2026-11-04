import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { barColor, barRange, changeBar } from "./diff.ts";

describe("barRange", () => {
  it("入るときは 1 行に 1 マス、入らなければ全体を高さに広げる（core.BarRange と同じ）", () => {
    assert.deepEqual(barRange(2, 10, 5), [2, 3]);
    assert.deepEqual(barRange(7, 10, 5), [5, 5]);
    assert.deepEqual(barRange(0, 4, 10), [0, 2]);
    assert.deepEqual(barRange(3, 4, 10), [7, 10]);
    assert.deepEqual(barRange(0, 0, 10), [0, 0]);
  });
});

describe("changeBar", () => {
  it("マス目ごとの変更の種類と、見えている範囲", () => {
    const cells = changeBar(
      {
        side: "new",
        top: 4,
        rows: 8,
        hunks: [
          { start: 0, end: 2, kind: "added" },
          { start: 2, end: 3, kind: "deleted" },
          { start: 6, end: 7, kind: "deleted" },
        ],
      },
      4,
    );
    // 1 マスが 2 行。0〜1 は足しただけ、2〜3 は消しただけ、4〜5 は無し、6〜7 は消しただけ
    assert.deepEqual(
      cells.map((c) => c.kind),
      ["added", "deleted", undefined, "deleted"],
    );
    // 見えているのは表示行 4〜7
    assert.deepEqual(
      cells.map((c) => c.view),
      [false, false, true, true],
    );
  });

  it("違う種類が同じマス目に入れば modified", () => {
    const cells = changeBar(
      {
        side: "unified",
        top: 0,
        rows: 4,
        hunks: [
          { start: 0, end: 1, kind: "added" },
          { start: 1, end: 2, kind: "deleted" },
        ],
      },
      2,
    );
    assert.equal(cells[0]?.kind, "modified");
    assert.equal(cells[1]?.kind, undefined);
  });

  it("色の名前", () => {
    assert.equal(barColor("added"), "diff.add.sign");
    assert.equal(barColor("deleted"), "diff.del.sign");
    assert.equal(barColor("modified"), "diff.mod.sign");
    assert.equal(barColor(undefined), undefined);
  });
});
