import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { proposeDimensions } from "coneko-term";

import { GAP, layoutRects } from "../../features/terminal/grid.ts";
import type { PaneLayout } from "../../infrastructure/rpc/protocol.ts";
import { TERM_PADDING_X, TERM_SCROLLBAR_WIDTH } from "../styles/monoFont.ts";
import {
  MIN_TERM_COLS,
  sidebarMax,
  TERM_CHROME_WIDTH,
  termMinWidth,
} from "./panes.ts";
import { cellWidthFromAdvances } from "./termCell.ts";

const pane = (id: string): PaneLayout => ({ pane: id });
const split = (
  dir: "right" | "down",
  ratio: number,
  a: PaneLayout,
  b: PaneLayout,
): PaneLayout => ({ dir, ratio, a, b });

const LAYOUTS: Record<string, PaneLayout | undefined> = {
  分けていない: undefined,
  "左右に 2 つ（均等）": split("right", 0.5, pane("a"), pane("b")),
  "左右に 2 つ（0.3）": split("right", 0.3, pane("a"), pane("b")),
  "左右に 2 つ（0.8）": split("right", 0.8, pane("a"), pane("b")),
  "上下に 2 つ": split("down", 0.5, pane("a"), pane("b")),
  "左右に 3 つ": split(
    "right",
    0.4,
    pane("a"),
    split("right", 0.5, pane("b"), pane("c")),
  ),
  左右の中で上下: split(
    "right",
    0.5,
    split("down", 0.5, pane("a"), pane("b")),
    pane("c"),
  ),
};

describe("字の幅（coneko-term の CanvasRenderer.measure と同じ式）", () => {
  it("いちばん広い送り幅を、デバイスピクセルで切り上げて dpr で割る", () => {
    // 11px の JetBrains Mono の送り幅は 6.6px。切り上げて 7px（"W" の幅 6.6 のままでは 18 列で止まる）
    assert.equal(
      cellWidthFromAdvances(() => 6.6, 1),
      7,
    );
    // dpr 2：13.2 デバイスピクセルを 14 に切り上げ、CSS ピクセルで 7
    assert.equal(
      cellWidthFromAdvances(() => 13.2, 2),
      7,
    );
    // 広い字があれば、そちらで決まる。測れない字（NaN）は飛ばす
    assert.equal(
      cellWidthFromAdvances((c) => (c === "W" ? 9 : c === "a" ? NaN : 6), 1),
      9,
    );
  });

  it("測れなければ undefined", () => {
    assert.equal(
      cellWidthFromAdvances(() => NaN, 1),
      undefined,
    );
    assert.equal(
      cellWidthFromAdvances(() => 7, 0),
      undefined,
    );
  });
});

describe("サイドバーの幅の上限と、ターミナルの列の数（#501）", () => {
  it("字の列の外側の幅は、terminal.css の余白とスクロールバーの幅と同じ", () => {
    const css = readFileSync(
      new URL("./content/terminal/terminal.css", import.meta.url),
      "utf8",
    );
    const m = /\.terminal-cell\s*\{[^}]*?padding:\s*(\d+)px\s+(\d+)px/.exec(
      css,
    );
    assert.ok(m, ".terminal-cell の padding が見つからない");
    assert.equal(Number(m[2]), TERM_PADDING_X);
    assert.equal(TERM_CHROME_WIDTH, TERM_PADDING_X * 2 + TERM_SCROLLBAR_WIDTH);
  });

  for (const [name, tree] of Object.entries(LAYOUTS)) {
    it(`上限いっぱいまで広げても、どのペインも coneko-term の fit で ${MIN_TERM_COLS} 列以上になる：${name}`, () => {
      for (const dpr of [1, 2, 3]) {
        for (let adv = 5; adv <= 14; adv += 0.35) {
          const cell = cellWidthFromAdvances(() => adv * dpr, dpr)!;
          for (const windowWidth of [800, 1024, 1440]) {
            const right =
              windowWidth - sidebarMax(windowWidth, cell, false, tree);
            // 上限は下限（200px）で止まるので、右の欄が足りるときだけ確かめる
            if (right < termMinWidth(cell, tree)) continue;
            for (const [id, r] of layoutRects(tree ?? pane("p"))) {
              // 欄の間の隙間（GAP）は、内側の辺の半分ずつを欄から引く
              const left = r.x > 0 ? GAP / 2 : 0;
              const rightEdge = r.x + r.w < 1 - 1e-9 ? GAP / 2 : 0;
              const w = r.w * right - left - rightEdge;
              const dims = proposeDimensions({
                width: w - TERM_PADDING_X * 2,
                height: 400,
                cellWidth: cell,
                cellHeight: 15,
                scrollbarWidth: TERM_SCROLLBAR_WIDTH,
              });
              assert.ok(
                dims && dims.cols >= MIN_TERM_COLS,
                `${name} ${id} dpr=${dpr} 字=${cell} 窓=${windowWidth}：${dims?.cols} 列`,
              );
            }
          }
        }
      }
    });
  }
});
