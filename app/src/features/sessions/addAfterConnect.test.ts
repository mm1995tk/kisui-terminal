import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { T } from "../../i18n/index.ts";
import {
  addAfterConnect,
  waitSettled,
  type AddSession,
} from "./addAfterConnect.ts";
import type { SessionState } from "./session.ts";

/** 状態を外から変えられる接続。 */
class FakeSession implements AddSession {
  state: SessionState = { kind: "connecting", attempt: 0, max: 0 };
  private hs = new Set<(s: SessionState) => void>();
  onState(h: (s: SessionState) => void) {
    this.hs.add(h);
    return () => this.hs.delete(h);
  }
  set(s: SessionState) {
    this.state = s;
    for (const h of [...this.hs]) h(s);
  }
  get listeners() {
    return this.hs.size;
  }
}

const connected = {
  kind: "connected",
  hello: {},
} as unknown as SessionState;

/** addAfterConnect を動かす。session は connect が返し、disconnect で current から外れる。 */
function setup(
  opts: { has?: boolean; write?: string; signal?: AbortSignal } = {},
) {
  const s = new FakeSession();
  let cur: FakeSession | undefined;
  const log: string[] = [];
  const result = addAfterConnect({
    hasSession: () => opts.has ?? false,
    connect: () => {
      log.push("connect");
      cur = s;
      return s;
    },
    current: () => cur,
    write: async () => {
      log.push("write");
      return opts.write;
    },
    disconnect: () => {
      log.push("disconnect");
      cur = undefined;
    },
    label: "dev",
    signal: opts.signal ?? new AbortController().signal,
  });
  return {
    s,
    log,
    result,
    /** ほかの所が切った */
    closeElsewhere() {
      cur = undefined;
      s.set({ kind: "closed" });
    },
  };
}

describe("addAfterConnect", () => {
  it("writes once connected", async () => {
    const t = setup();
    t.s.set({ kind: "needs-install" } as unknown as SessionState);
    t.s.set(connected);
    assert.equal(await t.result, undefined);
    assert.deepEqual(t.log, ["connect", "write"]);
    assert.equal(t.s.listeners, 0);
  });

  it("disconnects when it cannot write", async () => {
    const t = setup({ write: "no file" });
    t.s.set(connected);
    assert.equal(await t.result, "no file");
    assert.deepEqual(t.log, ["connect", "write", "disconnect"]);
  });

  it("disconnects without writing when it cannot connect", async () => {
    const t = setup();
    t.s.set({ kind: "failed", message: "refused" });
    assert.equal(
      await t.result,
      T("err.machine.connect", { machine: "dev", message: "refused" }),
    );
    assert.deepEqual(t.log, ["connect", "disconnect"]);

    const u = setup();
    u.s.set({ kind: "superseded" });
    assert.equal(
      await u.result,
      T("err.machine.usedByOther", { machine: "dev" }),
    );
    assert.deepEqual(u.log, ["connect", "disconnect"]);
  });

  it("does not disconnect again what was disconnected elsewhere", async () => {
    const t = setup();
    t.closeElsewhere();
    assert.equal(await t.result, T("machine.err.addCancelled"));
    assert.deepEqual(t.log, ["connect"]);
  });

  it("disconnects without writing when the request is taken back", async () => {
    const ac = new AbortController();
    const t = setup({ signal: ac.signal });
    ac.abort();
    assert.equal(await t.result, T("machine.err.addCancelled"));
    assert.deepEqual(t.log, ["connect", "disconnect"]);
    // そのあとつながっても、書かない
    t.s.set(connected);
    await Promise.resolve();
    assert.deepEqual(t.log, ["connect", "disconnect"]);
    assert.equal(t.s.listeners, 0);

    const pre = new AbortController();
    pre.abort();
    const u = setup({ signal: pre.signal });
    assert.equal(await u.result, T("machine.err.addCancelled"));
    assert.deepEqual(u.log, ["connect", "disconnect"]);
  });

  it("does not touch a destination that already has a connection", async () => {
    const t = setup({ has: true });
    assert.equal(await t.result, T("machine.err.connecting", { label: "dev" }));
    assert.deepEqual(t.log, []);
  });

  it("waitSettled answers at once for a state already settled", async () => {
    const s = new FakeSession();
    s.state = connected;
    assert.equal(await waitSettled(s, new AbortController().signal), connected);
    assert.equal(s.listeners, 0);
  });
});
