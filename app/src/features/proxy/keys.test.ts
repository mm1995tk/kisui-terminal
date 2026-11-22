import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { proxyPanelKey } from "./keys.ts";

const key = (key: string, mods: Partial<KeyboardEventInit> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("プロキシのパネルのキー", () => {
  it("一覧を動かす・中身を切り替える・戻る・閉じる", () => {
    assert.equal(proxyPanelKey(key("j")), "next");
    assert.equal(proxyPanelKey(key("ArrowUp")), "prev");
    assert.equal(proxyPanelKey(key("g")), "first");
    assert.equal(proxyPanelKey(key("G", { shiftKey: true })), "last");
    assert.equal(proxyPanelKey(key("Tab")), "side");
    assert.equal(proxyPanelKey(key("Tab", { shiftKey: true })), "side");
    assert.equal(proxyPanelKey(key("l")), "side");
    assert.equal(proxyPanelKey(key("Escape")), "back");
    assert.equal(proxyPanelKey(key("q")), "close");
  });

  it("修飾キーつき・ほかのキーは受けない（リーダーや近道に残す）", () => {
    assert.equal(proxyPanelKey(key("j", { ctrlKey: true })), null);
    assert.equal(proxyPanelKey(key("k", { metaKey: true })), null);
    assert.equal(proxyPanelKey(key("x")), null);
    assert.equal(proxyPanelKey(key("?", { shiftKey: true })), null);
  });
});
