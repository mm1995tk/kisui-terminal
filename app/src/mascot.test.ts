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

/** Web Animations の代わり。`animate` で始めた動きと、止められたかを覚える */
function fakeEl(left: number) {
  const el = {
    started: [] as { keyframes: { transform: string }[]; cancelled: boolean }[],
    getBoundingClientRect: () => ({ left }),
    animate(keyframes: { transform: string }[]) {
      const rec = { keyframes, cancelled: false };
      el.started.push(rec);
      return {
        cancel: () => {
          rec.cancelled = true;
        },
      };
    },
  };
  return el;
}
const asEl = (e: unknown) => e as HTMLElement;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("止める関数は Web Animations も止める", () => {
  it("運ぶ途中で止めると、案内とキャラクターの動きを cancel する", async () => {
    const { startCarry } = await import("./mascotMotion.ts");
    const menu = fakeEl(0);
    const char = fakeEl(0);
    const stop = startCarry(
      asEl(menu),
      () => asEl(char),
      1000,
      () => {},
      () => {},
    );
    await wait(5);
    assert.equal(menu.started.length, 1);
    assert.equal(char.started.length, 1);
    stop();
    assert.equal(menu.started[0].cancelled, true);
    assert.equal(char.started[0].cancelled, true);
  });

  it("去る途中で止める（開き直す）と、去る動きを cancel する", async () => {
    const { startLeave } = await import("./mascotMotion.ts");
    (globalThis as { window?: unknown }).window = { innerWidth: 1400 };
    const char = fakeEl(100);
    const stop = startLeave(
      () => asEl(char),
      () => {},
      () => {},
    );
    await wait(5);
    assert.equal(char.started.length, 1);
    stop();
    assert.equal(char.started[0].cancelled, true);
  });
});
