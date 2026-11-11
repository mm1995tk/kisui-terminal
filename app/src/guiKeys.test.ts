import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isEditorKey, isFocusLost, isMac } from "./guiKeys.ts";

describe("isFocusLost", () => {
  it("body・html・null は、どこにも向いていない", () => {
    const doc = { body: {}, documentElement: {} } as unknown as Document;
    assert.equal(isFocusLost(doc.body, doc), true);
    assert.equal(isFocusLost(doc.documentElement, doc), true);
    assert.equal(isFocusLost(null, doc), true);
    assert.equal(isFocusLost({}, doc), false);
  });
});

describe("isMac", () => {
  it("macOS だけ true", () => {
    assert.equal(isMac("MacIntel"), true);
    assert.equal(isMac("Linux x86_64"), false);
    assert.equal(isMac("Win32"), false);
  });
});

describe("isEditorKey", () => {
  it("Ctrl+E だけ。Shift・Alt・Cmd・変換中は違う", () => {
    const e = { key: "e", ctrlKey: true };
    assert.equal(isEditorKey(e), true);
    assert.equal(isEditorKey({ ...e, shiftKey: true }), false);
    assert.equal(isEditorKey({ ...e, altKey: true }), false);
    assert.equal(isEditorKey({ ...e, metaKey: true }), false);
    assert.equal(isEditorKey({ ...e, isComposing: true }), false);
  });
});
