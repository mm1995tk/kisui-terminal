import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isCancelKey } from "./cancelKey.ts";

describe("窓を閉じるキー", () => {
  it("Esc で閉じる", () => {
    assert.equal(isCancelKey({ key: "Escape", isComposing: false }), true);
  });
  it("変換中の Esc と、ほかのキーでは閉じない", () => {
    assert.equal(isCancelKey({ key: "Escape", isComposing: true }), false);
    assert.equal(isCancelKey({ key: "Enter", isComposing: false }), false);
  });
});
