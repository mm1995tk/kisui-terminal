import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FRAME_MS,
  nextAction,
  walkDuration,
  walkFrame,
  WALK_SPEED,
} from "./mascot.ts";

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

describe("walkDuration", () => {
  it("時間は距離に比例する（速さが一定）", () => {
    assert.equal(walkDuration(0), 0);
    assert.equal(walkDuration(WALK_SPEED), 1000);
    assert.equal(walkDuration(400) * 2, walkDuration(800));
    assert.equal(walkDuration(300) * 3, walkDuration(900));
  });

  it("負の距離は 0", () => {
    assert.equal(walkDuration(-10), 0);
  });

  it("ゆっくり歩く: 1 秒に高さの 1〜1.5 倍、幅 1400px ほどで 10 秒以上", () => {
    assert.ok(WALK_SPEED >= 72 && WALK_SPEED <= 72 * 1.5);
    assert.ok(walkDuration(1400) >= 10_000);
  });
});

describe("nextAction", () => {
  const base = {
    isOpen: true,
    wasOpen: false,
    hasMascot: true,
    reduced: false,
    shown: true,
  };

  it("開いたら運ぶ", () => {
    assert.equal(nextAction(base), "carry");
  });

  it("画像が無いとき・視差効果を減らすときは出さない", () => {
    assert.equal(nextAction({ ...base, hasMascot: false }), "clear");
    assert.equal(nextAction({ ...base, reduced: true }), "clear");
  });

  it("閉じたとき、出ていれば去る。出ていなければすぐ消える", () => {
    const closed = { ...base, isOpen: false, wasOpen: true };
    assert.equal(nextAction(closed), "leave");
    assert.equal(nextAction({ ...closed, shown: false }), "clear");
  });

  it("最初から閉じているときは何もしない", () => {
    assert.equal(
      nextAction({ ...base, isOpen: false, wasOpen: undefined }),
      "clear",
    );
  });
});
