import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { explorerRow, isLeaveExplorerKey } from "./explorerFocus.ts";

const k = (p: object) => ({
  key: "Escape",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...p,
});

describe("ファイルツリーから端末へ戻るキー", () => {
  it("Esc だけで戻る。修飾キー付きと変換中は戻らない", () => {
    assert.equal(isLeaveExplorerKey(k({})), true);
    assert.equal(isLeaveExplorerKey(k({ key: "a" })), false);
    assert.equal(isLeaveExplorerKey(k({ ctrlKey: true })), false);
    assert.equal(isLeaveExplorerKey(k({ shiftKey: true })), false);
    assert.equal(isLeaveExplorerKey(k({ isComposing: true })), false);
  });
  it("Ctrl+E でも戻る（#77）。ほかの修飾キーが加わると戻らない", () => {
    assert.equal(isLeaveExplorerKey(k({ key: "e", ctrlKey: true })), true);
    assert.equal(isLeaveExplorerKey(k({ key: "e" })), false);
    for (const m of ["shiftKey", "metaKey", "altKey", "isComposing"]) {
      assert.equal(
        isLeaveExplorerKey(k({ key: "e", ctrlKey: true, [m]: true })),
        false,
        m,
      );
    }
  });
});

describe("キーを向ける行", () => {
  const el = (n: string) => ({ n });
  const root = (sel: string | null, first: string | null) =>
    ({
      querySelector: (q: string) =>
        q.includes("aria-selected")
          ? sel
            ? el(sel)
            : null
          : first
            ? el(first)
            : null,
    }) as never;
  it("出しているファイルの行を先に、無ければ最初の行を選ぶ", () => {
    assert.deepEqual(explorerRow(root("cur", "top")), { n: "cur" });
    assert.deepEqual(explorerRow(root(null, "top")), { n: "top" });
    assert.equal(explorerRow(root(null, null)), null);
    assert.equal(explorerRow(undefined), null);
  });
});
