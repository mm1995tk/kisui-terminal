import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KeyLike } from "./files/input.ts";
import type { Files, Pane } from "./rpc/protocol.ts";
import { flipTransform, hasOpenFile, isModeKey, otherMode } from "./mode.ts";

function key(p: Partial<KeyLike>): KeyLike {
  return {
    key: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...p,
  };
}

describe("isModeKey", () => {
  it("Ctrl+Shift+` で入れ替える（US 配列は key が ~）", () => {
    assert.equal(
      isModeKey(
        key({ key: "~", code: "Backquote", ctrlKey: true, shiftKey: true }),
      ),
      true,
    );
  });

  it("JIS 配列（` は Shift+@）でも key で分かる", () => {
    assert.equal(
      isModeKey(
        key({ key: "`", code: "BracketLeft", ctrlKey: true, shiftKey: true }),
      ),
      true,
    );
  });

  it("修飾キーが足りない・多いときは入れ替えない", () => {
    assert.equal(isModeKey(key({ key: "`", code: "Backquote" })), false);
    assert.equal(
      isModeKey(key({ key: "`", code: "Backquote", ctrlKey: true })),
      false,
    );
    assert.equal(
      isModeKey(
        key({
          key: "~",
          code: "Backquote",
          ctrlKey: true,
          shiftKey: true,
          altKey: true,
        }),
      ),
      false,
    );
    assert.equal(
      isModeKey(
        key({
          key: "~",
          code: "Backquote",
          ctrlKey: true,
          shiftKey: true,
          metaKey: true,
        }),
      ),
      false,
    );
  });

  it("ほかのキーは入れ替えない", () => {
    assert.equal(
      isModeKey(key({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true })),
      false,
    );
  });
});

describe("otherMode", () => {
  it("IDE とターミナルを行き来する", () => {
    assert.equal(otherMode("ide"), "terminal");
    assert.equal(otherMode("terminal"), "ide");
  });
});

describe("flipTransform", () => {
  it("今の箱を前の箱に重ねる", () => {
    assert.equal(
      flipTransform(
        { left: 0, top: 600, width: 800, height: 300 },
        { left: 0, top: 0, width: 800, height: 600 },
      ),
      "translate(0px, 600px) scale(1, 0.5)",
    );
  });

  it("動かないときと大きさが 0 のときは null", () => {
    const b = { left: 10, top: 20, width: 30, height: 40 };
    assert.equal(flipTransform(b, b), null);
    assert.equal(flipTransform(b, { ...b, height: 0 }), null);
  });
});

describe("hasOpenFile", () => {
  const pane = (kind: string): Pane => ({
    id: kind === "welcome" ? "welcome" : "/w/a.txt",
    title: {} as Pane["title"],
    kind,
    viewport: {} as Pane["viewport"],
    curLine: 0,
  });
  const files = (...kinds: string[]): Files => ({
    panes: kinds.map(pane),
    active: 0,
  });

  it("画面が無い・files が無いときは開いていない", () => {
    assert.equal(hasOpenFile(null), false);
    assert.equal(hasOpenFile(undefined), false);
  });

  it("welcome のペインだけなら開いていない", () => {
    assert.equal(hasOpenFile(files("welcome")), false);
    assert.equal(hasOpenFile(files()), false);
  });

  it("text・image・diff・preview のペインがあれば開いている", () => {
    for (const k of ["text", "image", "diff", "preview"]) {
      assert.equal(hasOpenFile(files(k)), true, k);
    }
    assert.equal(hasOpenFile(files("diff", "text")), true);
  });
});
