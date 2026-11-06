import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cmdDigit,
  isCloseTermKey,
  isCmdKey,
  isCmdZoomKey,
  type KeyLike,
} from "./guiKeys.ts";
import { directionKey, isNewTermKey, isZoomKey } from "./terminal/grid.ts";

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

describe("Mac の Cmd のキー", () => {
  it("Cmd+T はターミナルを足す。Mac 以外では効かず、Ctrl+Shift+T は両方で効く", () => {
    const cmdT = key({ key: "t", code: "KeyT", metaKey: true });
    assert.equal(isNewTermKey(cmdT, true), true);
    assert.equal(isNewTermKey(cmdT, false), false);
    const csT = key({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true });
    assert.equal(isNewTermKey(csT, true), true);
    assert.equal(isNewTermKey(csT, false), true);
  });

  it("Cmd+Option+矢印で隣へ移る。Option だけ・Cmd だけでは移らない", () => {
    const k = (p: Partial<KeyLike>) => key({ key: "ArrowLeft", ...p });
    assert.equal(
      directionKey(k({ metaKey: true, altKey: true }), true),
      "left",
    );
    assert.equal(directionKey(k({ metaKey: true, altKey: true }), false), null);
    assert.equal(directionKey(k({ altKey: true }), true), null);
    assert.equal(directionKey(k({ metaKey: true }), true), null);
    assert.equal(
      directionKey(k({ ctrlKey: true, shiftKey: true }), true),
      "left",
    );
  });

  it("Cmd+W は Mac だけ。Shift や Option を足したら違う", () => {
    assert.equal(isCloseTermKey(key({ key: "w", metaKey: true }), true), true);
    assert.equal(
      isCloseTermKey(key({ key: "w", metaKey: true }), false),
      false,
    );
    assert.equal(
      isCloseTermKey(key({ key: "w", metaKey: true, shiftKey: true }), true),
      false,
    );
  });

  it("Cmd+1〜9 は 0〜8。0 や Option 付きは null", () => {
    assert.equal(cmdDigit(key({ key: "1", code: "Digit1", metaKey: true })), 0);
    assert.equal(cmdDigit(key({ key: "9", code: "Digit9", metaKey: true })), 8);
    assert.equal(
      cmdDigit(key({ key: "0", code: "Digit0", metaKey: true })),
      null,
    );
    assert.equal(
      cmdDigit(key({ key: "1", code: "Digit1", metaKey: true, altKey: true })),
      null,
    );
    assert.equal(cmdDigit(key({ key: "1", code: "Digit1" })), null);
  });

  it("Cmd+T・Cmd+1〜9 は Cmd だけのキー。Shift など別のキーを足したら違う", () => {
    assert.equal(isCmdKey(key({ key: "t", metaKey: true }), "t"), true);
    assert.equal(isCmdKey(key({ key: "s", metaKey: true }), "t"), false);
    assert.equal(
      isCmdKey(key({ key: "t", metaKey: true, shiftKey: true }), "t"),
      false,
    );
  });
});

describe("Cmd+Shift+Enter（プライマリ以外の欄を隠す）", () => {
  const cse = key({
    key: "Enter",
    code: "Enter",
    metaKey: true,
    shiftKey: true,
  });
  it("Mac では Cmd+Shift+Enter で隠す。GUI が受けるキー", () => {
    assert.equal(isCmdZoomKey(cse), true);
    assert.equal(isZoomKey(cse, true), true);
  });
  it("Shift が無い・Option も押している・Ctrl も押しているときは受けない", () => {
    assert.equal(isCmdZoomKey({ ...cse, shiftKey: false }), false);
    assert.equal(isCmdZoomKey({ ...cse, altKey: true }), false);
    assert.equal(isCmdZoomKey({ ...cse, ctrlKey: true }), false);
  });
  it("Mac 以外では受けない（ターミナルに送る）", () => {
    assert.equal(isZoomKey(cse, false), false);
  });
});
