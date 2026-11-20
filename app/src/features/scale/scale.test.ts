import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadScale, nextScale, saveScale } from "./scale.ts";

describe("表示の大きさ（#594）", () => {
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
