import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KeyLike } from "../guiKeys.ts";
import { switcherKey } from "./switcherKey.ts";

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

  it("Enter で移り、Tab で直前へ、1〜9 でその番号へ移る", () => {
    assert.deepEqual(switcherKey(key("Enter")), { kind: "go" });
    assert.deepEqual(switcherKey(key("Tab")), { kind: "last" });
    assert.deepEqual(switcherKey(key("1")), { kind: "nth", index: 0 });
    assert.deepEqual(switcherKey(key("9")), { kind: "nth", index: 8 });
    assert.equal(switcherKey(key("0")), null);
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
    assert.equal(switcherKey(key("x")), null);
    assert.equal(switcherKey(key("1", { altKey: true })), null);
    assert.equal(switcherKey(key("j", { metaKey: true })), null);
    assert.equal(switcherKey(key("Enter", { shiftKey: true })), null);
    assert.equal(switcherKey(key("Tab", { shiftKey: true })), null);
    assert.equal(switcherKey(key("j", { isComposing: true })), null);
  });
});
