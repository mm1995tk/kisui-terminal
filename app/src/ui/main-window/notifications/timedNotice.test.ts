import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { TimedNotice } from "./timedNotice.ts";

describe("TimedNotice", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("出して、時間が経つと自分で消える", () => {
    const log: boolean[] = [];
    const n = new TimedNotice((v) => log.push(v), 10);
    n.show();
    assert.deepEqual(log, [true]);
    mock.timers.tick(10);
    assert.deepEqual(log, [true, false]);
  });

  it("出ている間にもう一度出すと、数え直す", () => {
    const log: boolean[] = [];
    const n = new TimedNotice((v) => log.push(v), 30);
    n.show();
    mock.timers.tick(20);
    n.show();
    mock.timers.tick(20);
    assert.deepEqual(log, [true, true]);
    mock.timers.tick(10);
    assert.deepEqual(log, [true, true, false]);
  });
});
