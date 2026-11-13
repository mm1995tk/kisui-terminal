import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  explorerRow,
  isLeaveExplorerKey,
  startFocusStep,
} from "./explorerFocus.ts";

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

describe("startFocusStep（起動直後のツリーへのフォーカス）", () => {
  const base = {
    stillFocused: true,
    sidebarOpen: true,
    keyInTree: false,
    hasRow: true,
  };
  it("行がありキーがツリーに無ければ向ける", () => {
    assert.equal(startFocusStep(base), "focus");
  });
  it("行がまだ無ければ待つ（作ったばかりのワークスペース）", () => {
    assert.equal(startFocusStep({ ...base, hasRow: false }), "wait");
  });
  it("向け済みなら何もしない", () => {
    assert.equal(startFocusStep({ ...base, keyInTree: true }), "wait");
  });
  it("cd でツリーが捨てられ、行が消えて待ち、取り直されたら向け直す", () => {
    // 向けた行が消えた直後：キーはツリーに無く、行も無い
    assert.equal(startFocusStep({ ...base, hasRow: false }), "wait");
    // 取り直した行が描かれた
    assert.equal(startFocusStep(base), "focus");
  });
  it("サイドバーを閉じている間は、開かずに捨てる", () => {
    assert.equal(startFocusStep({ ...base, sidebarOpen: false }), "drop");
  });
  it("別のワークスペースに移ったら捨てる", () => {
    assert.equal(startFocusStep({ ...base, stillFocused: false }), "drop");
  });
});
