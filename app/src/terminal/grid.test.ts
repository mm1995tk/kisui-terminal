import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cellOf,
  directionKey,
  gridSize,
  isNewTermKey,
  neighbor,
} from "./grid.ts";

const key = (k: string, code = "", mods = { ctrl: true, shift: true }) => ({
  key: k,
  code,
  ctrlKey: mods.ctrl,
  shiftKey: mods.shift,
  altKey: false,
  metaKey: false,
});

describe("gridSize", () => {
  it("1 個は全体、2 個は左右、3〜4 個は 2×2、5〜6 個は 3×2", () => {
    assert.deepEqual(gridSize(1), { cols: 1, rows: 1 });
    assert.deepEqual(gridSize(2), { cols: 2, rows: 1 });
    assert.deepEqual(gridSize(3), { cols: 2, rows: 2 });
    assert.deepEqual(gridSize(4), { cols: 2, rows: 2 });
    assert.deepEqual(gridSize(5), { cols: 3, rows: 2 });
    assert.deepEqual(gridSize(6), { cols: 3, rows: 2 });
  });
});

describe("cellOf", () => {
  it("升目が余るときは、最後のターミナルが残りの幅を使う", () => {
    assert.deepEqual(cellOf(2, 3), { row: 1, col: 0, span: 2 });
    assert.deepEqual(cellOf(4, 5), { row: 1, col: 1, span: 2 });
    assert.deepEqual(cellOf(3, 4), { row: 1, col: 1, span: 1 });
    assert.deepEqual(cellOf(5, 6), { row: 1, col: 2, span: 1 });
  });
});

describe("neighbor", () => {
  it("左右は同じ行の隣、端では動かない", () => {
    assert.equal(neighbor(0, 2, "right"), 1);
    assert.equal(neighbor(1, 2, "right"), 1);
    assert.equal(neighbor(1, 2, "left"), 0);
    assert.equal(neighbor(0, 2, "left"), 0);
    // 2×2 の右上から右へは、次の行に回らない
    assert.equal(neighbor(1, 4, "right"), 1);
    assert.equal(neighbor(2, 4, "left"), 2);
  });

  it("上下は同じ列にかかる升へ。広い升からは左端の列で決める", () => {
    assert.equal(neighbor(0, 4, "down"), 2);
    assert.equal(neighbor(3, 4, "up"), 1);
    assert.equal(neighbor(1, 3, "down"), 2); // 下は 2 升ぶんの幅
    assert.equal(neighbor(2, 3, "up"), 0);
    assert.equal(neighbor(2, 5, "down"), 4);
    assert.equal(neighbor(4, 5, "up"), 1);
    assert.equal(neighbor(0, 2, "down"), 0);
    assert.equal(neighbor(0, 1, "up"), 0);
  });
});

describe("keys", () => {
  it("Ctrl+Shift+矢印だけを向きにする", () => {
    assert.equal(directionKey(key("ArrowLeft")), "left");
    assert.equal(directionKey(key("ArrowDown")), "down");
    assert.equal(
      directionKey(key("ArrowLeft", "", { ctrl: true, shift: false })),
      null,
    );
    assert.equal(directionKey(key("a")), null);
  });

  it("Ctrl+Shift+T を新しいターミナルのキーにする", () => {
    assert.equal(isNewTermKey(key("T", "KeyT")), true);
    assert.equal(isNewTermKey(key("t")), true);
    assert.equal(
      isNewTermKey(key("t", "KeyT", { ctrl: true, shift: false })),
      false,
    );
    assert.equal(isNewTermKey(key("Y", "KeyY")), false);
  });
});
