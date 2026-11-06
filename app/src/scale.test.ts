import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KeyLike } from "./guiKeys.ts";
import { loadScale, nextScale, saveScale, scaleKey } from "./scale.ts";

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

describe("表示の大きさのキー（#594）", () => {
  const k = (p: Partial<KeyLike>) => scaleKey(key(p), true);
  it("Mac は Cmd = / Cmd + で大きく、Cmd - で小さく、Cmd 0 で戻す", () => {
    assert.equal(k({ key: "=", code: "Equal", metaKey: true }), "in");
    assert.equal(
      k({ key: "+", code: "Equal", metaKey: true, shiftKey: true }),
      "in",
    );
    assert.equal(k({ key: "-", code: "Minus", metaKey: true }), "out");
    assert.equal(k({ key: "0", code: "Digit0", metaKey: true }), "reset");
  });
  it("Mac で Ctrl だけ、Alt 付き、Shift 付きの - と 0 は取らない", () => {
    assert.equal(k({ key: "-", code: "Minus", ctrlKey: true }), null);
    assert.equal(
      k({ key: "-", code: "Minus", metaKey: true, altKey: true }),
      null,
    );
    assert.equal(
      k({ key: "_", code: "Minus", metaKey: true, shiftKey: true }),
      null,
    );
    assert.equal(k({ key: "t", code: "KeyT", metaKey: true }), null);
  });
  it("Mac 以外は Ctrl で同じ。Cmd は取らない", () => {
    const o = (p: Partial<KeyLike>) => scaleKey(key(p), false);
    assert.equal(o({ key: "=", code: "Equal", ctrlKey: true }), "in");
    assert.equal(o({ key: "-", code: "Minus", ctrlKey: true }), "out");
    assert.equal(o({ key: "0", code: "Digit0", ctrlKey: true }), "reset");
    assert.equal(o({ key: "-", code: "Minus", metaKey: true }), null);
  });
  it("大きさは選べる値の隣へ動き、端で止まり、0 で戻る", () => {
    assert.equal(nextScale(1, "in"), 1.1);
    assert.equal(nextScale(1, "out"), 0.9);
    assert.equal(nextScale(2, "in"), 2);
    assert.equal(nextScale(0.7, "out"), 0.7);
    assert.equal(nextScale(1.5, "reset"), 1);
  });
  it("覚えた大きさを読み、壊れた値は元に戻す", () => {
    const mem = (v: string | null) => ({
      getItem: () => v,
      setItem: () => {},
    });
    assert.equal(loadScale(mem("1.25")), 1.25);
    assert.equal(loadScale(mem("9")), 1);
    assert.equal(loadScale(mem("x")), 1);
    assert.equal(loadScale(mem(null)), 1);
    assert.equal(loadScale(undefined), 1);
    let saved = "";
    saveScale({ getItem: () => null, setItem: (_k, v) => (saved = v) }, 1.5);
    assert.equal(saved, "1.5");
  });
});
