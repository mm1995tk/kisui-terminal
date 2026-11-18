import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isOpenableUrl, urlClickAction } from "./urlOpen.ts";

const click = (
  o: Partial<Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey", boolean>>,
) => ({
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...o,
});

describe("urlClickAction", () => {
  it("macOS では cmd+クリックと cmd+shift+クリックで開く", () => {
    assert.equal(urlClickAction(click({ metaKey: true }), true), "open");
    assert.equal(
      urlClickAction(click({ metaKey: true, shiftKey: true }), true),
      "open",
    );
  });
  it("macOS 以外では ctrl を使う。cmd（Windows キー）では開かない", () => {
    assert.equal(urlClickAction(click({ ctrlKey: true }), false), "open");
    assert.equal(
      urlClickAction(click({ ctrlKey: true, shiftKey: true }), false),
      "open",
    );
    assert.equal(urlClickAction(click({ metaKey: true }), false), null);
  });
  it("option（alt）を足すと、外のブラウザで開く。shift は付けても同じ", () => {
    assert.equal(
      urlClickAction(click({ metaKey: true, altKey: true }), true),
      "external",
    );
    assert.equal(
      urlClickAction(
        click({ metaKey: true, altKey: true, shiftKey: true }),
        true,
      ),
      "external",
    );
    assert.equal(
      urlClickAction(click({ ctrlKey: true, altKey: true }), false),
      "external",
    );
  });
  it("macOS で ctrl だけでは開かない（ctrl+クリックは右クリック）", () => {
    assert.equal(urlClickAction(click({ ctrlKey: true }), true), null);
  });
  it("修飾キーなし・shift だけ・alt だけのときは開かない", () => {
    assert.equal(urlClickAction(click({}), true), null);
    assert.equal(urlClickAction(click({ shiftKey: true }), true), null);
    assert.equal(urlClickAction(click({ altKey: true }), true), null);
    assert.equal(urlClickAction(click({ altKey: true }), false), null);
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
