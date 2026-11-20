import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dbEditorKey } from "./keys.ts";

const ev = (key: string, extra: object = {}) => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...extra,
});

describe("dbEditorKey（DB のタブの SQL の入力欄のキー）", () => {
  it("macOS は Cmd+Enter、ほかは Ctrl+Enter で実行する", () => {
    assert.equal(dbEditorKey(ev("Enter", { metaKey: true }), true), "run");
    assert.equal(dbEditorKey(ev("Enter", { ctrlKey: true }), false), "run");
    assert.equal(dbEditorKey(ev("Enter", { ctrlKey: true }), true), null);
    assert.equal(dbEditorKey(ev("Enter", { metaKey: true }), false), null);
  });

  it("Enter だけ・Shift や Alt を重ねたものは改行のまま", () => {
    assert.equal(dbEditorKey(ev("Enter"), true), null);
    assert.equal(
      dbEditorKey(ev("Enter", { ctrlKey: true, shiftKey: true }), false),
      null,
    );
    assert.equal(
      dbEditorKey(ev("Enter", { metaKey: true, altKey: true }), true),
      null,
    );
  });

  it("Esc は取り消す", () => {
    assert.equal(dbEditorKey(ev("Escape"), true), "cancel");
    assert.equal(dbEditorKey(ev("Escape", { ctrlKey: true }), false), null);
  });

  it("かな漢字変換の確定・取り消しのキーは受けない", () => {
    assert.equal(
      dbEditorKey(ev("Enter", { metaKey: true, isComposing: true }), true),
      null,
    );
    assert.equal(
      dbEditorKey(ev("Enter", { ctrlKey: true, keyCode: 229 }), false),
      null,
    );
    assert.equal(dbEditorKey(ev("Escape", { isComposing: true }), true), null);
  });
});
