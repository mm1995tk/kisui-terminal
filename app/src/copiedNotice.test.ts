import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { CopiedNotice, copyAndNotify } from "./copiedNotice.ts";

describe("CopiedNotice", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("出して、時間が経つと自分で消える", () => {
    const log: boolean[] = [];
    const n = new CopiedNotice((v) => log.push(v), 10);
    n.show();
    assert.deepEqual(log, [true]);
    mock.timers.tick(10);
    assert.deepEqual(log, [true, false]);
  });

  it("出ている間にもう一度出すと、数え直す", () => {
    const log: boolean[] = [];
    const n = new CopiedNotice((v) => log.push(v), 30);
    n.show();
    mock.timers.tick(20);
    n.show();
    mock.timers.tick(20);
    assert.deepEqual(log, [true, true]);
    mock.timers.tick(10);
    assert.deepEqual(log, [true, true, false]);
  });
});

describe("copyAndNotify", () => {
  it("書けたら知らせる", async () => {
    let n = 0;
    await copyAndNotify(
      async () => true,
      () => n++,
    );
    assert.equal(n, 1);
  });

  it("書けなかったら知らせない", async () => {
    let n = 0;
    await copyAndNotify(
      async () => false,
      () => n++,
    );
    assert.equal(n, 0);
  });
});
