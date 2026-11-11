import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { closeTarget, isEditorKey, isFocusLost, isMac } from "./guiKeys.ts";

describe("isFocusLost", () => {
  it("body・html・null は、どこにも向いていない", () => {
    const doc = { body: {}, documentElement: {} } as unknown as Document;
    assert.equal(isFocusLost(doc.body, doc), true);
    assert.equal(isFocusLost(doc.documentElement, doc), true);
    assert.equal(isFocusLost(null, doc), true);
    assert.equal(isFocusLost({}, doc), false);
  });
});

describe("closeTarget", () => {
  const doc = { body: {}, documentElement: {} } as unknown as Document;
  const inside = {};
  const card = { contains: (n: unknown) => n === inside };
  it("ターミナルの欄の中（PDF の iframe を含む）とどこにも向いていないときは、欄", () => {
    assert.equal(closeTarget(inside, card, doc), "pane");
    assert.equal(closeTarget(doc.body, card, doc), "pane");
    assert.equal(closeTarget(null, null, doc), "pane");
  });
  it("欄の外（サイドバー・入力欄など）や、欄が無いときは、窓", () => {
    assert.equal(closeTarget({}, card, doc), "window");
    assert.equal(closeTarget({}, null, doc), "window");
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
