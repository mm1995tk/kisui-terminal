import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { throttle, type Timers } from "./throttle.ts";

function fakeTimers() {
  let next = 1;
  const tasks = new Map<number, () => void>();
  const timers: Timers = {
    set: (fn) => {
      const id = next++;
      tasks.set(id, fn);
      return id;
    },
    clear: (id) => void tasks.delete(id as number),
  };
  const fire = () => {
    const [id, fn] = [...tasks][0] ?? [];
    if (id === undefined || !fn) return false;
    tasks.delete(id);
    fn();
    return true;
  };
  return { timers, fire };
}

describe("throttle", () => {
  it("最初の呼び出しはすぐ実行する", () => {
    const { timers } = fakeTimers();
    let n = 0;
    throttle(() => n++, 100, timers)();
    assert.equal(n, 1);
  });

  it("間隔の間の呼び出しは、明けたとき 1 回にまとめる", () => {
    const { timers, fire } = fakeTimers();
    let n = 0;
    const t = throttle(() => n++, 100, timers);
    t();
    t();
    t();
    assert.equal(n, 1);
    fire();
    assert.equal(n, 2);
    fire(); // 間隔の間に呼ばれなければ、もう実行しない
    assert.equal(n, 2);
    t();
    assert.equal(n, 3);
  });

  it("cancel すると待っていた実行をやめる", () => {
    const { timers, fire } = fakeTimers();
    let n = 0;
    const t = throttle(() => n++, 100, timers);
    t();
    t();
    t.cancel();
    assert.equal(fire(), false);
    assert.equal(n, 1);
    t();
    assert.equal(n, 2);
  });
});
