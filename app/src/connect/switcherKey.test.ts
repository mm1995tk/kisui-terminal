import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KeyLike } from "../guiKeys.ts";
import { confirmKey, switcherKey } from "./switcherKey.ts";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("ワークスペースを切り替える窓のキー", () => {
  it("j k と矢印と Ctrl+J / Ctrl+K で、選ぶ行を動かす", () => {
    for (const k of ["j", "ArrowDown"])
      assert.deepEqual(switcherKey(key(k)), { kind: "move", to: "next" });
    for (const k of ["k", "ArrowUp"])
      assert.deepEqual(switcherKey(key(k)), { kind: "move", to: "prev" });
    assert.deepEqual(switcherKey(key("j", { ctrlKey: true })), {
      kind: "move",
      to: "next",
    });
    assert.deepEqual(switcherKey(key("k", { ctrlKey: true })), {
      kind: "move",
      to: "prev",
    });
  });

  it("Enter で移る。Tab と 1〜9 は受けない（j k で選ぶ）", () => {
    assert.deepEqual(switcherKey(key("Enter")), { kind: "go" });
    assert.equal(switcherKey(key("Tab")), null);
    assert.equal(switcherKey(key("1")), null);
    assert.equal(switcherKey(key("9")), null);
  });

  it("n は作り、r は名前を変え、x は閉じる", () => {
    assert.deepEqual(switcherKey(key("n")), { kind: "new" });
    assert.deepEqual(switcherKey(key("r")), { kind: "rename" });
    assert.deepEqual(switcherKey(key("x")), { kind: "close" });
    assert.equal(switcherKey(key("x", { ctrlKey: true })), null);
    assert.equal(switcherKey(key("n", { metaKey: true })), null);
  });

  it("J K（Shift+j・Shift+k）は並べ替える", () => {
    assert.deepEqual(switcherKey(key("J", { shiftKey: true })), {
      kind: "reorder",
      dir: "down",
    });
    assert.deepEqual(switcherKey(key("K", { shiftKey: true })), {
      kind: "reorder",
      dir: "up",
    });
  });

  it("絞り込みの字は受けず、Alt・Cmd を重ねたものと変換中のキーは受けない", () => {
    assert.equal(switcherKey(key("a")), null);
    assert.equal(switcherKey(key("q")), null);
    assert.equal(switcherKey(key("x", { altKey: true })), null);
    assert.equal(switcherKey(key("j", { metaKey: true })), null);
    assert.equal(switcherKey(key("Enter", { shiftKey: true })), null);
    assert.equal(switcherKey(key("j", { isComposing: true })), null);
    // 変換を確定する Enter（compositionend のあとに keyCode 229 で来る）で移らない
    assert.equal(switcherKey(key("Enter", { keyCode: 229 })), null);
    assert.equal(switcherKey(key("Process", { keyCode: 229 })), null);
  });
});

describe("閉じる確認のキー", () => {
  it("y で閉じ、n でやめる。ほかのキーと、Ctrl・Cmd・Alt を重ねたものと、変換中のキーは何もしない", () => {
    assert.equal(confirmKey(key("y")), "yes");
    assert.equal(confirmKey(key("n")), "no");
    assert.equal(confirmKey(key("x")), null);
    assert.equal(confirmKey(key("Enter")), null);
    assert.equal(confirmKey(key("y", { ctrlKey: true })), null);
    assert.equal(confirmKey(key("y", { isComposing: true })), null);
    assert.equal(confirmKey(key("n", { keyCode: 229 })), null);
  });
});
