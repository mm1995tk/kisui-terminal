import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  argFlag,
  argOptionalString,
  argString,
  createWindowRun,
  WindowCommandError,
} from "./windowRun.ts";
import { LOCAL } from "../sessions/shell.ts";

const rq = (
  command: string,
  args: Record<string, unknown> = {},
  id = "x1",
) => ({
  id,
  pane: "t1",
  tab: "w1",
  command,
  args,
});

describe("window.run の受け口", () => {
  it("名前の受け持ちに、引数と頼んだ側を渡し、返した値を result にする", async () => {
    const seen: unknown[] = [];
    const w = createWindowRun([
      {
        "tab.rename": {
          remote: true,
          run: (args, c) => {
            seen.push([args, c.from, c.pane, c.tab]);
            return { id: "w9" };
          },
        },
      },
      { "workspace.list": { remote: true, run: async () => undefined } },
    ]);
    assert.deepEqual(await w.run("dev", rq("tab.rename", { tab: "a" })), {
      result: { id: "w9" },
    });
    assert.deepEqual(seen, [[{ tab: "a" }, "dev", "t1", "w1"]]);
    // 何も返さない受け持ちの result は、空のオブジェクト
    assert.deepEqual(await w.run("dev", rq("workspace.list")), { result: {} });
  });

  it("知らない名前・受け持ちの断りは、理由（と code）にして返す（投げない）", async () => {
    const w = createWindowRun([
      {
        "tab.close": {
          remote: true,
          run: () => {
            throw new WindowCommandError("running", "busy");
          },
        },
        "tab.show": {
          remote: true,
          run: () => {
            throw new WindowCommandError("no tab");
          },
        },
        "tab.move": {
          remote: true,
          run: () => Promise.reject(new Error("boom")),
        },
      },
    ]);
    const unknown = await w.run("dev", rq("tab.nope"));
    assert.ok("error" in unknown && unknown.error.includes("tab.nope"));
    assert.deepEqual(await w.run("dev", rq("tab.close")), {
      error: "running",
      code: "busy",
    });
    assert.deepEqual(await w.run("dev", rq("tab.show")), { error: "no tab" });
    assert.deepEqual(await w.run("dev", rq("tab.move")), { error: "boom" });
  });

  it("remote を書いていない受け持ちは、リモートの Machine の Pane の頼みを渡されない（既定で閉じる）", async () => {
    const seen: string[] = [];
    const w = createWindowRun([
      {
        "workspace.close": {
          run: (_, c) => {
            seen.push(c.from);
            return { ok: true };
          },
        },
      },
    ]);
    const r = await w.run("dev", rq("workspace.close"));
    assert.ok("error" in r && r.error.includes("workspace.close"));
    assert.deepEqual(seen, []);
    // 手元の PC の Pane の頼みは渡す
    assert.deepEqual(await w.run(LOCAL, rq("workspace.close")), {
      result: { ok: true },
    });
    assert.deepEqual(seen, [LOCAL]);
  });

  it("同じ名前の受け持ちが 2 つあれば、作るときに投げる", () => {
    assert.throws(() =>
      createWindowRun([
        { "tab.list": { run: () => 1 } },
        { "tab.list": { run: () => 2 } },
      ]),
    );
  });

  it("取り下げは、その Machine のその頼みの signal だけを終わらせる", async () => {
    const signals: AbortSignal[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const w = createWindowRun([
      {
        "clipboard.history": {
          remote: true,
          run: async (_, c) => {
            signals.push(c.signal);
            await held;
          },
        },
      },
    ]);
    const a = w.run("dev", rq("clipboard.history", {}, "x1"));
    const b = w.run("build", rq("clipboard.history", {}, "x1"));
    w.cancel("dev", "x1");
    assert.deepEqual(
      signals.map((s) => s.aborted),
      [true, false],
    );
    release();
    await Promise.all([a, b]);
    // 終わった頼みの取り下げは、何もしない
    w.cancel("build", "x1");
    assert.equal(signals[1].aborted, false);
  });

  it("引数は、型を確かめてから使う", () => {
    assert.equal(argString({ tab: "a" }, "tab"), "a");
    assert.throws(() => argString({ tab: 1 }, "tab"), WindowCommandError);
    assert.throws(() => argString({}, "tab"), WindowCommandError);
    assert.equal(argOptionalString({}, "workspace"), undefined);
    assert.throws(
      () => argOptionalString({ workspace: [] }, "workspace"),
      WindowCommandError,
    );
    assert.equal(argFlag({}, "force"), false);
    assert.equal(argFlag({ force: true }, "force"), true);
    assert.throws(() => argFlag({ force: "yes" }, "force"), WindowCommandError);
  });
});
