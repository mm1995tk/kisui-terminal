import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { forceCloseWorkspace, type ConfirmClose } from "./confirmClose.ts";

describe("forceCloseWorkspace", () => {
  it("窓を閉じたあとで accessor を読めなくなっても、force を付けて閉じる", () => {
    let state: ConfirmClose | null = { target: "local", id: "w1", name: "a" };
    // Solid の <Show> の accessor と同じく、状態が null になったあとに読むと投げる
    const read = () => {
      if (!state) throw new Error("Stale read from <Show>");
      return state;
    };
    const calls: string[] = [];
    forceCloseWorkspace(
      read,
      () => (state = null),
      (target, id, force) => calls.push(`${target}/${id}/${force}`),
    );
    assert.equal(state, null);
    assert.deepEqual(calls, ["local/w1/true"]);
  });
});
