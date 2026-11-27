import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createUpdates, type UpdateOutcome, type UpdatesOs } from "./store.ts";

const NEW = { current: "0.1.0", version: "0.2.0", notes: null };

/** 殻の偽物。check は起動時の答え、checkNow は調べ直したときの答え。調べ直した回数と入れた回数を数える。 */
function fakeOs(opts: {
  check?: typeof NEW | null;
  checkNow?: UpdateOutcome;
  installFails?: boolean;
}) {
  const calls = { checkNow: 0, install: 0 };
  const os: UpdatesOs = {
    check: async () => opts.check ?? null,
    checkNow: async () => {
      calls.checkNow++;
      return opts.checkNow ?? { status: "latest", current: "0.1.0" };
    },
    install: async () => {
      calls.install++;
      if (opts.installFails) throw new Error("download failed");
    },
  };
  return { os, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("新しい版の updateNow（リーダーの i u）", () => {
  it("「あとで」で知らせを閉じたあとも、調べ直して知らせを出し直し、入れる", async () => {
    const { os, calls } = fakeOs({
      check: NEW,
      checkNow: { status: "available", ...NEW },
    });
    const u = createUpdates(os);
    u.checkOnStart();
    await tick();
    u.dismiss();
    assert.equal(u.info(), null);
    assert.equal(await u.updateNow(), null);
    assert.equal(calls.checkNow, 1);
    assert.equal(calls.install, 1);
    assert.deepEqual(u.info(), NEW);
  });

  it("調べ直しても新しい版が無ければ、入れずに答えを返す", async () => {
    const { os, calls } = fakeOs({});
    const u = createUpdates(os);
    assert.deepEqual(await u.updateNow(), {
      status: "latest",
      current: "0.1.0",
    });
    assert.equal(calls.install, 0);
    assert.equal(u.info(), null);
  });

  it("入れるのに失敗したら、知らせに理由を出す", async () => {
    const { os } = fakeOs({
      checkNow: { status: "available", ...NEW },
      installFails: true,
    });
    const u = createUpdates(os);
    await u.updateNow();
    assert.deepEqual(u.info(), NEW);
    assert.match(u.error(), /download failed/);
    assert.equal(u.busy(), false);
  });
});
