import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isNewTab, moveSelection, newTabKey, NEW_TAB_URL } from "./newTab.ts";

const ev = (key: string, mods = "", isComposing = false) => ({
  key,
  ctrlKey: mods.includes("c"),
  shiftKey: mods.includes("s"),
  altKey: mods.includes("a"),
  metaKey: mods.includes("m"),
  isComposing,
});

describe("新しいタブのページ（#238）", () => {
  it("URL が空のタブが、新しいタブのページ", () => {
    assert.equal(isNewTab({ url: NEW_TAB_URL }), true);
    assert.equal(isNewTab({ url: "https://example.com/" }), false);
  });

  it("↓ ↑ と Ctrl+J / Ctrl+K で選び、Enter で開き、Esc でやめる", () => {
    assert.deepEqual(newTabKey(ev("ArrowDown")), { kind: "step", step: 1 });
    assert.deepEqual(newTabKey(ev("ArrowUp")), { kind: "step", step: -1 });
    assert.deepEqual(newTabKey(ev("j", "c")), { kind: "step", step: 1 });
    assert.deepEqual(newTabKey(ev("k", "c")), { kind: "step", step: -1 });
    assert.deepEqual(newTabKey(ev("Enter")), { kind: "enter" });
    assert.deepEqual(newTabKey(ev("Escape")), { kind: "cancel" });
  });

  it("字のキー・修飾つきの Enter・変換中のキーは受けない", () => {
    assert.equal(newTabKey(ev("j")), null);
    assert.equal(newTabKey(ev("Enter", "s")), null);
    assert.equal(newTabKey(ev("Enter", "", true)), null);
    assert.equal(newTabKey(ev("Escape", "", true)), null);
  });

  it("変換を確定する Enter が keyCode 229 で来ても開かない（macOS の WKWebView、#298）", () => {
    assert.equal(newTabKey({ ...ev("Enter"), keyCode: 229 }), null);
    assert.deepEqual(newTabKey({ ...ev("Enter"), keyCode: 13 }), {
      kind: "enter",
    });
  });

  it("選ぶ所は検索窓（-1）から始まり、端で回らない", () => {
    assert.equal(moveSelection(-1, 1, 3), 0);
    assert.equal(moveSelection(0, 1, 3), 1);
    assert.equal(moveSelection(2, 1, 3), 2);
    assert.equal(moveSelection(0, -1, 3), -1);
    assert.equal(moveSelection(-1, -1, 3), -1);
    assert.equal(moveSelection(-1, 1, 0), -1);
  });
});
