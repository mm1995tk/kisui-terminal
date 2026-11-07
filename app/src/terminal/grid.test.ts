import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PaneLayout } from "../rpc/protocol.ts";
import {
  directionKey,
  isZoomKey,
  layoutPanes,
  layoutRects,
  neighbor,
  reconcileLayout,
  splitKey,
} from "./grid.ts";

const key = (k: string, code = "", mods = { ctrl: true, shift: true }) => ({
  key: k,
  code,
  ctrlKey: mods.ctrl,
  shiftKey: mods.shift,
  altKey: false,
  metaKey: false,
});

const leaf = (pane: string): PaneLayout => ({ pane });
const right = (a: PaneLayout, b: PaneLayout): PaneLayout => ({
  dir: "right",
  ratio: 0.5,
  a,
  b,
});
const down = (a: PaneLayout, b: PaneLayout): PaneLayout => ({
  dir: "down",
  ratio: 0.5,
  a,
  b,
});

describe("layoutRects", () => {
  it("右は左右、下は上下に分け、入れ子にできる", () => {
    const r = layoutRects(right(leaf("a"), down(leaf("b"), leaf("c"))));
    assert.deepEqual(r.get("a"), { x: 0, y: 0, w: 0.5, h: 1 });
    assert.deepEqual(r.get("b"), { x: 0.5, y: 0, w: 0.5, h: 0.5 });
    assert.deepEqual(r.get("c"), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it("割合で分ける", () => {
    const r = layoutRects({
      dir: "right",
      ratio: 0.25,
      a: leaf("a"),
      b: leaf("b"),
    });
    assert.deepEqual(r.get("a"), { x: 0, y: 0, w: 0.25, h: 1 });
    assert.deepEqual(r.get("b"), { x: 0.25, y: 0, w: 0.75, h: 1 });
  });
});

describe("reconcileLayout", () => {
  it("木が無ければ、欄を右・下・右…と交互に分けて並べる。数に上限は無い", () => {
    const ids = ["p", "t1", "t2", "t3", "t4", "t5", "t6", "t7"];
    const n = reconcileLayout(undefined, ids)!;
    assert.deepEqual(layoutPanes(n), ids);
    assert.equal("dir" in n && n.dir, "right");
    assert.equal(layoutRects(n).size, 8);
  });

  it("合っている木は同じ物のまま返す", () => {
    const n = right(leaf("a"), leaf("b"));
    assert.equal(reconcileLayout(n, ["a", "b"]), n);
  });

  it("閉じた欄は外し、隣がその場所を埋める", () => {
    const n = right(leaf("a"), down(leaf("b"), leaf("c")));
    assert.deepEqual(
      reconcileLayout(n, ["a", "c"]),
      right(leaf("a"), leaf("c")),
    );
    assert.deepEqual(
      reconcileLayout(n, ["a", "b"]),
      right(leaf("a"), leaf("b")),
    );
    assert.deepEqual(
      reconcileLayout(n, ["b", "c"]),
      down(leaf("b"), leaf("c")),
    );
  });

  it("木に無い欄は最後の欄を分けて足す", () => {
    const n = reconcileLayout(right(leaf("a"), leaf("b")), ["a", "b", "c"]);
    assert.deepEqual(n, right(leaf("a"), down(leaf("b"), leaf("c"))));
  });
});

describe("neighbor", () => {
  const tree = right(leaf("a"), down(leaf("b"), leaf("c")));
  const rects = layoutRects(tree);

  it("辺が接している欄へ移り、端では動かない", () => {
    assert.equal(neighbor(rects, "a", "right"), "b"); // 上端にかかる欄
    assert.equal(neighbor(rects, "b", "left"), "a");
    assert.equal(neighbor(rects, "c", "left"), "a");
    assert.equal(neighbor(rects, "b", "down"), "c");
    assert.equal(neighbor(rects, "c", "up"), "b");
    assert.equal(neighbor(rects, "a", "left"), undefined);
    assert.equal(neighbor(rects, "a", "up"), undefined);
    assert.equal(neighbor(rects, "c", "down"), undefined);
    assert.equal(neighbor(rects, "c", "right"), undefined);
  });

  it("上下は、今の欄の左端にかかる欄へ", () => {
    // a b / c c
    const t = down(right(leaf("a"), leaf("b")), leaf("c"));
    const r = layoutRects(t);
    assert.equal(neighbor(r, "c", "up"), "a");
    assert.equal(neighbor(r, "b", "down"), "c");
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

  it("Linux は Ctrl+Shift+D で右、Ctrl+Shift+E で下に分ける", () => {
    assert.equal(splitKey(key("D", "KeyD")), "right");
    assert.equal(splitKey(key("d")), "right");
    assert.equal(splitKey(key("E", "KeyE")), "down");
    assert.equal(
      splitKey(key("d", "KeyD", { ctrl: true, shift: false })),
      null,
    );
    // 前の Ctrl+Shift+T は欄を足さない
    assert.equal(splitKey(key("T", "KeyT")), null);
  });

  it("Ctrl+Shift+M をプライマリ以外の欄を隠すキーにする", () => {
    assert.equal(isZoomKey(key("M", "KeyM")), true);
    assert.equal(isZoomKey(key("m")), true);
    assert.equal(
      isZoomKey(key("m", "KeyM", { ctrl: true, shift: false })),
      false,
    );
    assert.equal(isZoomKey(key("T", "KeyT")), false);
  });
});
