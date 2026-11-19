import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { afterChangesKey, continuesInTerminal } from "./handover.ts";

describe("afterChangesKey", () => {
  const setup = () => {
    const log: string[] = [];
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const p = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return {
      log,
      resolve,
      reject,
      p,
      h: {
        toTerminal: () => log.push("terminal"),
        fail: (e: unknown) => log.push(`fail:${String(e)}`),
      },
    };
  };

  it("space・: は、shj.changesKey が通る前に端末へキーを向けない（通ってから向ける）", async () => {
    for (const key of ["space", ":"] as const) {
      const t = setup();
      afterChangesKey(key, t.p, t.h);
      await Promise.resolve();
      assert.deepEqual(t.log, [], "返事の前");
      t.resolve();
      await t.p;
      await Promise.resolve();
      assert.deepEqual(t.log, ["terminal"], key);
    }
  });

  it("断られたら端末へ向けず、エラーを出す", async () => {
    const t = setup();
    afterChangesKey("space", t.p, t.h);
    t.reject("no");
    await t.p.catch(() => {});
    await Promise.resolve();
    assert.deepEqual(t.log, ["fail:no"]);
  });

  it("s・r・R は端末へ向けない", async () => {
    for (const key of ["s", "r", "R"] as const) {
      const t = setup();
      afterChangesKey(key, t.p, t.h);
      t.resolve();
      await t.p;
      await Promise.resolve();
      assert.deepEqual(t.log, [], key);
      assert.equal(continuesInTerminal(key), false);
    }
  });
});
