import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Files, Pane } from "../rpc/protocol.ts";
import { activeSplit, splitKindAt } from "./split.ts";

const pane = (id: string, kind: string) => ({ id, kind }) as Pane;

describe("ファイルの欄の左右の境界", () => {
  const diff = [pane("a.go:base", "diff"), pane("a.go", "diff")];
  const prev = [pane("a.md", "text"), pane("a.md#preview", "preview")];

  it("差分の分割とプレビューの分割を見分ける", () => {
    assert.equal(splitKindAt(diff, 1), "diff");
    assert.equal(splitKindAt(prev, 1), "preview");
    assert.equal(splitKindAt(prev, 0), null);
    assert.equal(splitKindAt(prev, 2), null);
  });

  it("ファイルを 2 つ並べた境界や、プレビューだけの欄は動かせない", () => {
    assert.equal(
      splitKindAt([pane("a.go", "text"), pane("b.go", "text")], 1),
      null,
    );
    assert.equal(
      splitKindAt([pane("a.go", "text"), pane("b.md#preview", "preview")], 1),
      null,
    );
  });

  it("今のファイルの境界を返す", () => {
    assert.equal(activeSplit({ panes: diff, active: 1 } as Files), "diff");
    assert.equal(activeSplit({ panes: prev, active: 0 } as Files), "preview");
    assert.equal(activeSplit({ panes: [prev[0]!], active: 0 } as Files), null);
    assert.equal(activeSplit(null), null);
  });
});
