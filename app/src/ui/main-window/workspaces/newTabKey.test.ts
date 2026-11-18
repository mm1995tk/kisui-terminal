import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import { newTabInputKey, newTabListKey } from "./newTabKey.ts";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("タブを作る行の、名前の入力欄のキー", () => {
  it("Tab で次のマシン、Shift+Tab で前のマシンに替える", () => {
    assert.deepEqual(newTabInputKey(key("Tab")), {
      kind: "machine",
      to: "next",
    });
    assert.deepEqual(newTabInputKey(key("Tab", { shiftKey: true })), {
      kind: "machine",
      to: "prev",
    });
    assert.equal(newTabInputKey(key("Tab", { ctrlKey: true })), null);
  });

  it("↓ で一覧を開く。Enter で作り、Esc でやめる", () => {
    assert.deepEqual(newTabInputKey(key("ArrowDown")), { kind: "openList" });
    assert.deepEqual(newTabInputKey(key("Enter")), { kind: "submit" });
    assert.deepEqual(newTabInputKey(key("Escape")), { kind: "cancel" });
  });

  it("字（j n N など）は受けない（入力欄にそのまま打てる）", () => {
    for (const k of ["j", "n", "N", "x", " "])
      assert.equal(newTabInputKey(key(k)), null);
  });

  it("変換中のキーでは、決めない・やめない・マシンを替えない・一覧を開かない", () => {
    for (const k of ["Enter", "Escape", "Tab", "ArrowDown"]) {
      assert.equal(newTabInputKey(key(k, { isComposing: true })), null);
      assert.equal(newTabInputKey(key(k, { keyCode: 229 })), null);
    }
  });
});

describe("タブを作る行の、マシンの一覧のキー", () => {
  it("j k と ↓ ↑ で選び、Enter で決め、Esc で一覧だけを閉じる", () => {
    for (const k of ["j", "ArrowDown"])
      assert.deepEqual(newTabListKey(key(k)), { kind: "move", to: "next" });
    for (const k of ["k", "ArrowUp"])
      assert.deepEqual(newTabListKey(key(k)), { kind: "move", to: "prev" });
    assert.deepEqual(newTabListKey(key("Enter")), { kind: "choose" });
    assert.deepEqual(newTabListKey(key("Escape")), { kind: "close" });
  });

  it("ほかのキーと、Ctrl・Cmd・Alt を重ねたものと、変換中のキーは受けない", () => {
    assert.equal(newTabListKey(key("a")), null);
    assert.equal(newTabListKey(key("j", { ctrlKey: true })), null);
    assert.equal(newTabListKey(key("Enter", { keyCode: 229 })), null);
    assert.equal(newTabListKey(key("Escape", { isComposing: true })), null);
  });
});
