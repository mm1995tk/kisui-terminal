import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isOpenableUrl, isUrlOpenClick } from "./urlOpen.ts";

const click = (
  o: Partial<Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey", boolean>>,
) => ({
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...o,
});

describe("isUrlOpenClick", () => {
  it("macOS では cmd+クリックと cmd+shift+クリックで開く", () => {
    assert.equal(isUrlOpenClick(click({ metaKey: true }), true), true);
    assert.equal(
      isUrlOpenClick(click({ metaKey: true, shiftKey: true }), true),
      true,
    );
  });
  it("macOS 以外では ctrl を使う。cmd（Windows キー）では開かない", () => {
    assert.equal(isUrlOpenClick(click({ ctrlKey: true }), false), true);
    assert.equal(
      isUrlOpenClick(click({ ctrlKey: true, shiftKey: true }), false),
      true,
    );
    assert.equal(isUrlOpenClick(click({ metaKey: true }), false), false);
  });
  it("macOS で ctrl だけでは開かない（ctrl+クリックは右クリック）", () => {
    assert.equal(isUrlOpenClick(click({ ctrlKey: true }), true), false);
  });
  it("修飾キーなし・shift だけ・alt が付いたときは開かない", () => {
    assert.equal(isUrlOpenClick(click({}), true), false);
    assert.equal(isUrlOpenClick(click({ shiftKey: true }), true), false);
    assert.equal(
      isUrlOpenClick(click({ metaKey: true, altKey: true }), true),
      false,
    );
  });
});

describe("isOpenableUrl", () => {
  it("http と https だけ", () => {
    assert.equal(isOpenableUrl("https://example.com/a?b=1"), true);
    assert.equal(isOpenableUrl("http://localhost:3000"), true);
    for (const s of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ftp://x.com",
      "tauri://x",
      "",
      "example.com",
    ])
      assert.equal(isOpenableUrl(s), false, s);
  });
});
