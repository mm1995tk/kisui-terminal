import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { forceCloseWorkspace, type ConfirmClose } from "./confirmClose.ts";

describe("forceCloseWorkspace", () => {
  it("窓を閉じたあとには読めなくなる状態でも、先に読んで force を付けて閉じる", () => {
    let state: ConfirmClose | null = { target: "local", id: "w1", name: "a" };
    const calls: string[] = [];
    forceCloseWorkspace(
      () => state,
      () => (state = null),
      (target, id, force) => calls.push(`${target}/${id}/${force}`),
    );
    assert.equal(state, null);
    assert.deepEqual(calls, ["local/w1/true"]);
  });

  it("窓が開いていなければ、何も閉じない", () => {
    const calls: string[] = [];
    forceCloseWorkspace(
      () => null,
      () => {},
      (target, id) => calls.push(`${target}/${id}`),
    );
    assert.deepEqual(calls, []);
  });
});
