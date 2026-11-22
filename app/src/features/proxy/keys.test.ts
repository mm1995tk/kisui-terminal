import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { proxyEditKey, proxyPanelKey } from "./keys.ts";

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
    assert.equal(proxyPanelKey(key("e")), "edit");
    assert.equal(proxyPanelKey(key("i")), "hold");
    assert.equal(proxyPanelKey(key("f")), "forward");
    assert.equal(proxyPanelKey(key("d")), "drop");
  });

  it("修飾キーつき・ほかのキーは受けない（リーダーや近道に残す）", () => {
    assert.equal(proxyPanelKey(key("j", { ctrlKey: true })), null);
    assert.equal(proxyPanelKey(key("k", { metaKey: true })), null);
    assert.equal(proxyPanelKey(key("x")), null);
    assert.equal(proxyPanelKey(key("?", { shiftKey: true })), null);
  });
});

describe("要求を書き換える欄のキー（#410）", () => {
  it("Cmd+Enter（macOS）・Ctrl+Enter（ほか）で送り、Esc でやめる", () => {
    assert.equal(proxyEditKey(key("Enter", { metaKey: true }), true), "send");
    assert.equal(proxyEditKey(key("Enter", { ctrlKey: true }), false), "send");
    assert.equal(proxyEditKey(key("Escape"), true), "cancel");
  });

  it("Enter だけ・ほかの修飾キー・字は欄に残す", () => {
    assert.equal(proxyEditKey(key("Enter"), true), null);
    assert.equal(proxyEditKey(key("Enter", { ctrlKey: true }), true), null);
    assert.equal(proxyEditKey(key("Enter", { metaKey: true }), false), null);
    assert.equal(
      proxyEditKey(key("Enter", { metaKey: true, shiftKey: true }), true),
      null,
    );
    assert.equal(proxyEditKey(key("e"), true), null);
    assert.equal(proxyEditKey(key("q"), true), null);
  });

  it("かな漢字変換の確定は受けない", () => {
    assert.equal(
      proxyEditKey(key("Enter", { metaKey: true, isComposing: true }), true),
      null,
    );
  });
});
