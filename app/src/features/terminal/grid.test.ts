import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PaneLayout } from "../../infrastructure/rpc/protocol.ts";
import {
  clampRatio,
  firstPane,
  GAP,
  layoutBars,
  layoutPanes,
  layoutRects,
  limitedRatio,
  neighbor,
  ratioLimits,
  reconcileLayout,
  widthForPanes,
  withRatio,
} from "./grid.ts";

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

describe("欄どうしの Pane border（#18）", () => {
  // a | (b / c)
  const tree = right(leaf("a"), down(leaf("b"), leaf("c")));

  it("Pane border は B 側の左上の欄で指し、根から順に並ぶ", () => {
    assert.equal(firstPane(tree), "a");
    const bars = layoutBars(tree);
    assert.deepEqual(
      bars.map((b) => [b.key, b.dir]),
      [
        ["b", "right"],
        ["c", "down"],
      ],
    );
    // 内側の Pane border の範囲は、右半分
    assert.deepEqual(bars[1]!.node, { x: 0.5, y: 0, w: 0.5, h: 1 });
    assert.deepEqual(layoutBars(leaf("a")), []);
  });

  it("割合を変えた木を返し、元の木は変えない。無い Pane border は同じ木", () => {
    const t = withRatio(tree, "c", 0.25) as Extract<
      PaneLayout,
      { dir: string }
    >;
    assert.equal((t.b as { ratio: number }).ratio, 0.25);
    assert.equal(t.ratio, 0.5);
    assert.equal((tree as { b: { ratio: number } }).b.ratio, 0.5);
    assert.equal(withRatio(tree, "a", 0.1), tree);
    // 割合を変えると、欄の位置も変わる
    assert.equal(layoutRects(withRatio(tree, "b", 0.25)).get("a")!.w, 0.25);
  });

  const size = (cols: number, rows: number) => () => ({ cols, rows });

  it("両側が最小の大きさ（20 列・5 行）を下回らない範囲に収める", () => {
    const t = right(leaf("a"), leaf("b"));
    const [lo, hi] = ratioLimits(t, "b", size(80, 24))!;
    assert.equal(lo, 20 / 160);
    assert.equal(hi, 1 - 20 / 160);
    assert.equal(limitedRatio(t, "b", 0.01, size(80, 24)), 0.125);
    assert.equal(limitedRatio(t, "b", 0.99, size(80, 24)), 0.875);
    assert.equal(limitedRatio(t, "b", 0.3333, size(80, 24)), 0.333);
    // 下に分ける Pane border は行で見る
    const d = down(leaf("a"), leaf("b"));
    assert.equal(limitedRatio(d, "b", 0.01, size(80, 24)), 0.105); // 5 / 48 = 0.1041…。切り上げて範囲の中に残す
  });

  it("入れ子の側は、中の欄の最小の大きさの分だけ残す", () => {
    // (a | b) | c の外側の Pane border：A 側は 2 枚が横に並ぶので 40 列は要る
    const t = right(right(leaf("a"), leaf("b")), leaf("c"));
    const [lo] = ratioLimits(t, "c", size(80, 24))!;
    assert.equal(lo, 40 / 240);
  });

  it("大きさが分からない欄は固定の範囲。すでに小さすぎれば動かせない", () => {
    const t = right(leaf("a"), leaf("x"));
    const some = (id: string) =>
      id === "a" ? { cols: 80, rows: 24 } : undefined;
    assert.deepEqual(ratioLimits(t, "x", some), [0.05, 0.95]);
    assert.equal(limitedRatio(t, "x", 0.5, size(15, 24)), undefined);
    assert.equal(limitedRatio(t, "zz", 0.5, size(80, 24)), undefined);
  });

  it("丸めても範囲の中に残す", () => {
    assert.equal(clampRatio(0.12345, 0.1, 0.9), 0.123);
    assert.equal(clampRatio(0, 0.1234, 0.9), 0.124);
    assert.equal(clampRatio(1, 0.1, 0.8765), 0.876);
  });
});

describe("widthForPanes", () => {
  const w = 100;
  const rt = (ratio: number, a: PaneLayout, b: PaneLayout): PaneLayout => ({
    dir: "right",
    ratio,
    a,
    b,
  });
  it("分けていなければ、欄 1 つぶん", () => {
    assert.equal(widthForPanes(undefined, w), w);
    assert.equal(widthForPanes(leaf("a"), w), w);
    assert.equal(widthForPanes(down(leaf("a"), leaf("b")), w), w);
  });

  it("均等に分けていれば、欄の数ぶんに隙間（GAP）を足した幅", () => {
    assert.equal(widthForPanes(right(leaf("a"), leaf("b")), w), 2 * w + GAP);
  });

  it("割合が均等でなければ、いちばん狭い欄が paneWidth になる幅", () => {
    // 0.7 : 0.3 は、狭い 0.3 の側で決まる（右の欄の左の隙間 GAP / 2 を足してから 0.3 で割る）
    const near = (x: number, y: number) => assert.ok(Math.abs(x - y) < 1e-6);
    near(widthForPanes(rt(0.7, leaf("a"), leaf("b")), w), (w + GAP / 2) / 0.3);
    near(widthForPanes(rt(0.2, leaf("a"), leaf("b")), w), (w + GAP / 2) / 0.2);
  });

  it("入れ子の割合も、どの欄も paneWidth 以上になるように求める", () => {
    // 左 0.5 の欄 a、右 0.5 の中を 0.5 : 0.5 に分ける：右の中の狭い欄は全体の 0.25
    const t = rt(0.5, leaf("a"), rt(0.5, leaf("b"), leaf("c")));
    const need = widthForPanes(t, w);
    const rects = layoutRects(t);
    for (const id of ["a", "b", "c"]) {
      const r = rects.get(id)!;
      // 隣と接している辺の隙間の半分ずつを引いた幅
      const gaps = id === "a" ? GAP / 2 : id === "b" ? GAP : GAP / 2;
      assert.ok(r.w * need - gaps >= w - 1e-6, id);
    }
  });
});
