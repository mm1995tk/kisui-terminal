import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isOpenableUrl, urlTarget } from "./urlOpen.ts";

const click = (
  o: Partial<Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey", boolean>>,
) => ({
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...o,
});

describe("urlTarget", () => {
  it("設定が external なら、cmd+shift は OS 既定、cmd だけは内蔵（macOS）", () => {
    assert.equal(
      urlTarget(click({ metaKey: true, shiftKey: true }), true, "external"),
      "external",
    );
    assert.equal(
      urlTarget(click({ metaKey: true }), true, "external"),
      "builtin",
    );
  });
  it("設定が builtin なら反対になる", () => {
    assert.equal(
      urlTarget(click({ metaKey: true, shiftKey: true }), true, "builtin"),
      "builtin",
    );
    assert.equal(
      urlTarget(click({ metaKey: true }), true, "builtin"),
      "external",
    );
  });
  it("macOS 以外では ctrl を使う。cmd（Windows キー）では開かない", () => {
    assert.equal(
      urlTarget(click({ ctrlKey: true }), false, "external"),
      "builtin",
    );
    assert.equal(
      urlTarget(click({ ctrlKey: true, shiftKey: true }), false, "external"),
      "external",
    );
    assert.equal(
      urlTarget(click({ metaKey: true }), false, "external"),
      undefined,
    );
  });
  it("macOS で ctrl だけでは開かない（ctrl+クリックは右クリック）", () => {
    assert.equal(
      urlTarget(click({ ctrlKey: true }), true, "external"),
      undefined,
    );
  });
  it("修飾キーなし・shift だけ・alt が付いたときは開かない", () => {
    assert.equal(urlTarget(click({}), true, "external"), undefined);
    assert.equal(
      urlTarget(click({ shiftKey: true }), true, "external"),
      undefined,
    );
    assert.equal(
      urlTarget(click({ metaKey: true, altKey: true }), true, "external"),
      undefined,
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
