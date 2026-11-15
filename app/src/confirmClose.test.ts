import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { forceCloseWorkspace, type ConfirmClose } from "./confirmClose.ts";

describe("forceCloseWorkspace", () => {
  it("窓を閉じたあとには読めなくなる状態でも、先に読んで force を付けて閉じる", () => {
    let state: ConfirmClose | null = { gws: "g1", name: "a" };
    const calls: string[] = [];
    forceCloseWorkspace(
      () => state,
      () => (state = null),
      (gws, force) => calls.push(`${gws}/${force}`),
    );
    assert.equal(state, null);
    assert.deepEqual(calls, ["g1/true"]);
  });

  it("窓が開いていなければ、何も閉じない", () => {
    const calls: string[] = [];
    forceCloseWorkspace(
      () => null,
      () => {},
      (gws) => calls.push(gws),
    );
    assert.deepEqual(calls, []);
  });
});
