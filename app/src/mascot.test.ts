import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FRAME_MS, walkFrame } from "./mascot.ts";

describe("walkFrame", () => {
  it("1 コマずつ進み、4 コマで 1 周する", () => {
    assert.equal(walkFrame(0), 0);
    assert.equal(walkFrame(FRAME_MS - 1), 0);
    assert.equal(walkFrame(FRAME_MS), 1);
    assert.equal(walkFrame(FRAME_MS * 3), 3);
    assert.equal(walkFrame(FRAME_MS * 4), 0);
  });

  it("負の時間は最初のコマ", () => {
    assert.equal(walkFrame(-5), 0);
  });
});
