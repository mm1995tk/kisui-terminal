import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyTextInputDefaults,
  type AttrTarget,
} from "./textInputDefaults.ts";

function fakeEl(init: Record<string, string> = {}): AttrTarget & {
  attrs: Map<string, string>;
} {
  const attrs = new Map(Object.entries(init));
  return {
    attrs,
    hasAttribute: (n) => attrs.has(n),
    setAttribute: (n, v) => void attrs.set(n, v),
  };
}

describe("applyTextInputDefaults", () => {
  it("属性の無い欄に、大文字化・自動修正・スペルチェックを切る属性を付ける", () => {
    const el = fakeEl();
    applyTextInputDefaults(el);
    assert.equal(el.attrs.get("autocapitalize"), "off");
    assert.equal(el.attrs.get("autocorrect"), "off");
    assert.equal(el.attrs.get("spellcheck"), "false");
  });

  it("欄が自分で付けた属性は上書きしない", () => {
    const el = fakeEl({ autocapitalize: "sentences", spellcheck: "true" });
    applyTextInputDefaults(el);
    assert.equal(el.attrs.get("autocapitalize"), "sentences");
    assert.equal(el.attrs.get("spellcheck"), "true");
    assert.equal(el.attrs.get("autocorrect"), "off");
  });
});
