import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { machineIndex, stepMachine } from "./newTabMachine.ts";

describe("タブを作る行の、選んでいるマシン", () => {
  const ts = ["local", "devbox", "gpu"];

  it("target から位置を求める。候補に無ければ先頭、候補が 0 件でも 0", () => {
    assert.equal(machineIndex(ts, "devbox"), 1);
    assert.equal(machineIndex(ts, "gone"), 0);
    assert.equal(machineIndex(ts, undefined), 0);
    assert.equal(machineIndex([], "local"), 0);
  });

  it("次・前に替える（端では回る）", () => {
    assert.equal(stepMachine(ts, "local", "next"), "devbox");
    assert.equal(stepMachine(ts, "gpu", "next"), "local");
    assert.equal(stepMachine(ts, "local", "prev"), "gpu");
  });

  it("ほかのマシンが切れて候補が縮んでも、選んでいたマシンのまま", () => {
    assert.equal(machineIndex(["devbox", "gpu"], "gpu"), 1);
    assert.equal(stepMachine(["devbox", "gpu"], "gpu", "next"), "devbox");
  });

  it("候補が 0 件なら、替えても NaN にならず undefined", () => {
    assert.equal(stepMachine([], "local", "next"), undefined);
    assert.equal(stepMachine([], undefined, "prev"), undefined);
  });
});
