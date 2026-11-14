import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FRAME_MS, nextAction, walkFrame } from "./mascot.ts";

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

describe("nextAction", () => {
  const base = {
    isOpen: true,
    wasOpen: false,
    hasMascot: true,
    reduced: false,
    hasLeave: true,
    shown: true,
  };

  it("開いたら運ぶ", () => {
    assert.equal(nextAction(base), "carry");
  });

  it("画像が無いとき・視差効果を減らすときは出さない", () => {
    assert.equal(nextAction({ ...base, hasMascot: false }), "clear");
    assert.equal(nextAction({ ...base, reduced: true }), "clear");
  });

  it("閉じたとき、leave.png があれば去る。無ければすぐ消える", () => {
    const closed = { ...base, isOpen: false, wasOpen: true };
    assert.equal(nextAction(closed), "leave");
    assert.equal(nextAction({ ...closed, hasLeave: false }), "clear");
    assert.equal(nextAction({ ...closed, shown: false }), "clear");
  });

  it("最初から閉じているときは何もしない", () => {
    assert.equal(
      nextAction({ ...base, isOpen: false, wasOpen: undefined }),
      "clear",
    );
  });
});
