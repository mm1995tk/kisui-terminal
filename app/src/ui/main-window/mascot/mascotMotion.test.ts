import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import type { Mascot, MascotScene } from "../../../features/mascot/mascot.ts";
import { startRest } from "./mascotMotion.ts";

const scene = (
  frames: string[],
  o: Partial<MascotScene> = {},
): MascotScene => ({ frames, frameMs: 100, loop: true, speed: 90, ...o });

const mascot = (o: Partial<Mascot> = {}): Mascot => ({
  carry: scene(["w1", "w2"]),
  sigh: scene(["sigh"], { loop: false }),
  rest: [],
  restAfterMs: 3000,
  bye: [],
  push: null,
  ...o,
});

describe("startRest（一息つく → 待つ → 休憩の具体 → 一息つくに戻る）", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval"] }));
  afterEach(() => mock.timers.reset());

  it("待ち時間が経つまでは一息つく姿のまま", () => {
    const seen: string[] = [];
    const stop = startRest(
      mascot({ rest: [scene(["coffee"], { loop: false })] }),
      (f) => seen.push(f),
      () => 0,
    );
    mock.timers.tick(2999);
    assert.deepEqual([...new Set(seen)], ["sigh"]);
    stop();
  });

  it("くり返さない具体は、終わると一息つくに戻り、また待ってから選び直す", () => {
    const seen: string[] = [];
    const picks: number[] = [];
    const rests = [
      scene(["a1", "a2"], { loop: false }),
      scene(["b1"], { loop: false }),
    ];
    const randoms = [0, 0.9];
    const stop = startRest(
      mascot({ rest: rests }),
      (f) => seen.push(f),
      () => {
        const r = randoms[picks.length] ?? 0;
        picks.push(r);
        return r;
      },
    );
    mock.timers.tick(3000);
    assert.equal(seen.at(-1), "a1");
    mock.timers.tick(200); // a1, a2 を再生し終える
    assert.equal(seen.at(-1), "sigh");
    mock.timers.tick(2900);
    assert.equal(picks.length, 1); // まだ待っている
    mock.timers.tick(100);
    assert.equal(picks.length, 2);
    assert.equal(seen.at(-1), "b1");
    stop();
  });

  it("くり返す具体は、止めるまでくり返す", () => {
    const seen: string[] = [];
    const stop = startRest(
      mascot({ rest: [scene(["c1", "c2"])] }),
      (f) => seen.push(f),
      () => 0,
    );
    mock.timers.tick(3000 + 10_000);
    assert.ok(["c1", "c2"].includes(seen.at(-1) ?? ""));
    stop();
  });

  it("休憩の具体が無ければ、一息つく姿のまま", () => {
    const seen: string[] = [];
    const stop = startRest(
      mascot(),
      (f) => seen.push(f),
      () => 0,
    );
    mock.timers.tick(60_000);
    assert.deepEqual([...new Set(seen)], ["sigh"]);
    stop();
  });

  it("止めると、待っていても休憩に入らない", () => {
    const seen: string[] = [];
    const stop = startRest(
      mascot({ rest: [scene(["coffee"])] }),
      (f) => seen.push(f),
      () => 0,
    );
    stop();
    mock.timers.tick(10_000);
    assert.deepEqual([...new Set(seen)], ["sigh"]);
  });

  it("待ち時間は restAfterMs", () => {
    const seen: string[] = [];
    const stop = startRest(
      mascot({ rest: [scene(["coffee"])], restAfterMs: 500 }),
      (f) => seen.push(f),
      () => 0,
    );
    mock.timers.tick(500);
    assert.equal(seen.at(-1), "coffee");
    stop();
  });
});
