import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { focusLastNotified, rememberNotified } from "./lastNotified.ts";

describe("最後に通知を出したペイン", () => {
  it("覚えていなければ何もしない", () => {
    assert.equal(focusLastNotified(), false);
  });

  it("最後に通知を出したペインを前に出す", () => {
    const calls: string[] = [];
    const forgetA = rememberNotified(() => calls.push("a"));
    const forgetB = rememberNotified(() => calls.push("b"));
    assert.equal(focusLastNotified(), true);
    assert.deepEqual(calls, ["b"]);
    // 古いペインが無くなっても、最後のペインは忘れない
    forgetA();
    assert.equal(focusLastNotified(), true);
    // 最後のペインが無くなれば忘れる
    forgetB();
    assert.equal(focusLastNotified(), false);
  });
});
