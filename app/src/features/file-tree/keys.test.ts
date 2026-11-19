import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { treeKey } from "./keys.ts";

const fileRow = { dir: false, expanded: false };
const closed = { dir: true, expanded: false };
const open = { dir: true, expanded: true };
const k = (key: string) => ({ key });

describe("treeKey", () => {
  it("j k と ↓ ↑ で上下、g G と Home End で先頭・末尾へ", () => {
    for (const key of ["j", "ArrowDown"])
      assert.deepEqual(treeKey(fileRow, k(key)), { kind: "move", to: "next" });
    for (const key of ["k", "ArrowUp"])
      assert.deepEqual(treeKey(fileRow, k(key)), { kind: "move", to: "prev" });
    for (const key of ["g", "Home"])
      assert.deepEqual(treeKey(open, k(key)), { kind: "move", to: "first" });
    for (const key of ["G", "End"])
      assert.deepEqual(treeKey(open, k(key)), { kind: "move", to: "last" });
  });

  it("l と → は閉じたフォルダを開き、ファイルを開く。開いたフォルダでは何もしない", () => {
    for (const key of ["l", "ArrowRight"]) {
      assert.deepEqual(treeKey(closed, k(key)), {
        kind: "row",
        action: "toggle",
      });
      assert.deepEqual(treeKey(fileRow, k(key)), {
        kind: "row",
        action: "open",
      });
      assert.equal(treeKey(open, k(key)), null);
    }
  });

  it("h と ← は開いたフォルダを閉じ、ほかは親のフォルダへ", () => {
    for (const key of ["h", "ArrowLeft"]) {
      assert.deepEqual(treeKey(open, k(key)), {
        kind: "row",
        action: "toggle",
      });
      assert.deepEqual(treeKey(closed, k(key)), {
        kind: "move",
        to: "parent",
      });
      assert.deepEqual(treeKey(fileRow, k(key)), {
        kind: "move",
        to: "parent",
      });
    }
  });

  it("Enter と Space は押したのと同じ", () => {
    assert.deepEqual(treeKey(fileRow, k("Enter")), {
      kind: "row",
      action: "open",
    });
    assert.deepEqual(treeKey(open, k(" ")), { kind: "row", action: "toggle" });
  });

  it("a・A・r・d・y・Y はメニューの項目と同じ操作", () => {
    const cases: [string, string][] = [
      ["a", "new-file"],
      ["n", "new-file"],
      ["A", "new-dir"],
      ["N", "new-dir"],
      ["r", "rename"],
      ["d", "delete"],
      ["Delete", "delete"],
      ["y", "copy-relative"],
      ["Y", "copy-absolute"],
    ];
    for (const [key, action] of cases) {
      assert.deepEqual(treeKey(fileRow, k(key)), { kind: "menu", action });
      assert.deepEqual(treeKey(closed, k(key)), { kind: "menu", action });
    }
  });

  it("Ctrl・Cmd・Alt つき、変換中、割り当ての無いキー、5000 件より先の行では何もしない", () => {
    assert.equal(treeKey(fileRow, { key: "d", ctrlKey: true }), null);
    assert.equal(treeKey(fileRow, { key: "a", metaKey: true }), null);
    assert.equal(treeKey(fileRow, { key: "j", altKey: true }), null);
    assert.equal(treeKey(fileRow, { key: "d", isComposing: true }), null);
    assert.equal(treeKey(fileRow, k("x")), null);
    assert.equal(treeKey(fileRow, k("Tab")), null);
    assert.equal(treeKey({ ...fileRow, truncated: true }, k("j")), null);
  });
});
