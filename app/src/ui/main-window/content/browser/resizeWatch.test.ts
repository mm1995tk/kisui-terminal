import assert from "node:assert/strict";
import { it } from "node:test";

import { watchResize } from "./resizeWatch.ts";

// 時計を自分で進める窓の代わり
function fake() {
  let now = 0;
  let next = 1;
  let onResize: () => void = () => {};
  const timers = new Map<number, { at: number; f: () => void }>();
  const target = {
    addEventListener: (_: string, f: () => void) => (onResize = f),
    removeEventListener: () => (onResize = () => {}),
    setTimeout: (f: () => void, ms: number) => {
      timers.set(next, { at: now + ms, f });
      return next++;
    },
    clearTimeout: (t: number) => void timers.delete(t),
  };
  return {
    target: target as never,
    fire: () => onResize(),
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers])
        if (t.at <= now) {
          timers.delete(id);
          t.f();
        }
    },
  };
}

it("asks to resend after a resize, and again once it settles", () => {
  const w = fake();
  const r = watchResize(w.target);
  assert.equal(r.take(), false);
  w.fire();
  assert.equal(r.take(), true);
  assert.equal(r.take(), false);
  w.advance(150);
  assert.equal(r.take(), true);
  w.advance(350);
  assert.equal(r.take(), true);
  assert.equal(r.take(), false);
  r.stop();
});

it("a new resize restarts the wait, and stop cancels it", () => {
  const w = fake();
  const r = watchResize(w.target);
  w.fire();
  r.take();
  w.advance(100);
  w.fire();
  r.take();
  w.advance(100);
  assert.equal(r.take(), false);
  r.stop();
  w.advance(1000);
  assert.equal(r.take(), false);
});
