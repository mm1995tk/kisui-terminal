import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dbEditorKey, dbHistoryKey, dbResultKey, dbTreeKey } from "./keys.ts";

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

describe("dbTreeKey（左の木のペインのキー）", () => {
  it("上下・開け閉め・先頭末尾・Enter・Esc", () => {
    const k = (key: string, extra: object = {}) => dbTreeKey(ev(key, extra));
    assert.equal(k("j"), "next");
    assert.equal(k("ArrowDown"), "next");
    assert.equal(k("k"), "prev");
    assert.equal(k("l"), "expand");
    assert.equal(k("ArrowLeft"), "collapse");
    assert.equal(k("g"), "first");
    assert.equal(k("G", { shiftKey: true }), "last");
    assert.equal(k("Enter"), "enter");
    assert.equal(k("Escape"), "back");
  });

  it("Ctrl・Cmd・Alt を重ねたものは受けない（リーダーなどに残す）", () => {
    for (const key of ["j", "Enter", "Escape"])
      for (const m of ["ctrlKey", "metaKey", "altKey"])
        assert.equal(dbTreeKey(ev(key, { [m]: true })), null);
  });

  it("かな漢字変換のキーは受けない", () => {
    assert.equal(dbTreeKey(ev("Enter", { isComposing: true })), null);
    assert.equal(dbTreeKey(ev("Enter", { keyCode: 229 })), null);
    assert.equal(dbTreeKey(ev("Escape", { isComposing: true })), null);
  });
});

describe("dbHistoryKey（履歴の窓のキー）", () => {
  it("↓ ↑・Ctrl+J / Ctrl+K で動き、Enter で選ぶ", () => {
    assert.deepEqual(dbHistoryKey(ev("ArrowDown"), true), {
      kind: "step",
      step: 1,
    });
    assert.deepEqual(dbHistoryKey(ev("ArrowUp"), true), {
      kind: "step",
      step: -1,
    });
    assert.deepEqual(dbHistoryKey(ev("j", { ctrlKey: true }), true), {
      kind: "step",
      step: 1,
    });
    assert.deepEqual(dbHistoryKey(ev("k", { ctrlKey: true }), true), {
      kind: "step",
      step: -1,
    });
    assert.deepEqual(dbHistoryKey(ev("Enter"), true), { kind: "choose" });
  });

  it("字（j k を含む）は入力欄に入る。Shift+Enter は受けない", () => {
    assert.equal(dbHistoryKey(ev("j"), true), null);
    assert.equal(dbHistoryKey(ev("k"), true), null);
    assert.equal(dbHistoryKey(ev("a"), true), null);
    assert.equal(dbHistoryKey(ev("Enter", { shiftKey: true }), true), null);
  });

  it("`?` は、絞り込みが空のときだけキーの一覧", () => {
    assert.deepEqual(dbHistoryKey(ev("?", { shiftKey: true }), true), {
      kind: "help",
    });
    assert.equal(dbHistoryKey(ev("?", { shiftKey: true }), false), null);
  });

  it("かな漢字変換のキーは受けない", () => {
    assert.equal(dbHistoryKey(ev("Enter", { isComposing: true }), true), null);
    assert.equal(
      dbHistoryKey(ev("ArrowDown", { isComposing: true }), true),
      null,
    );
  });
});

describe("dbResultKey（DB のタブの結果の表のキー）", () => {
  it("macOS は Cmd+C、ほかは Ctrl+C でコピーする", () => {
    assert.equal(dbResultKey(ev("c", { metaKey: true }), true), "copy");
    assert.equal(dbResultKey(ev("c", { ctrlKey: true }), false), "copy");
    assert.equal(dbResultKey(ev("c", { ctrlKey: true }), true), null);
    assert.equal(dbResultKey(ev("c", { metaKey: true }), false), null);
  });
  it("C だけ・Shift や Alt を重ねたものは受けない", () => {
    assert.equal(dbResultKey(ev("c"), true), null);
    assert.equal(
      dbResultKey(ev("C", { ctrlKey: true, shiftKey: true }), false),
      null,
    );
    assert.equal(
      dbResultKey(ev("c", { metaKey: true, altKey: true }), true),
      null,
    );
  });
});
