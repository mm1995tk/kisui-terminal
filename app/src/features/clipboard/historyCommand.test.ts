import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WindowRunReport } from "../../infrastructure/rpc/protocol.ts";

import { createWindowRun } from "../commands/windowRun.ts";
import { LOCAL } from "../sessions/shell.ts";
import { createClipboardCommands } from "./historyCommand.ts";

/** 答えの、断りの理由（行えたなら undefined）。 */
const errorOf = (r: WindowRunReport) => ("error" in r ? r.error : undefined);

const rq = (id = "x1") => ({
  id,
  pane: "t1",
  tab: "w1",
  command: "clipboard.history",
  args: {},
});

/** 答えを、テストが決める聞き手。 */
function asker() {
  const asked: { answer: (ok: boolean) => void; cancelled: boolean }[] = [];
  const ask = () => {
    let answer!: (ok: boolean) => void;
    const allowed = new Promise<boolean>((r) => (answer = r));
    const q = { answer, cancelled: false };
    asked.push(q);
    return {
      allowed,
      cancel: () => {
        q.cancelled = true;
        answer(false);
      },
    };
  };
  return { asked, ask };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("kisui clipboard history（#517）", () => {
  const entries = [
    { text: "new", copiedAt: 2 },
    { text: "old", copiedAt: 1 },
  ];

  it("読むたびに人に聞き、許したときだけ履歴を返す（答えは覚えない）", async () => {
    const { asked, ask } = asker();
    let listed = 0;
    const w = createWindowRun([
      createClipboardCommands({
        list: async () => {
          listed++;
          return entries;
        },
        ask,
      }),
    ]);
    const first = w.run(LOCAL, rq("a"));
    await tick();
    assert.equal(asked.length, 1);
    assert.equal(listed, 0);
    asked[0]!.answer(true);
    assert.deepEqual(await first, { result: { entries } });
    const second = w.run(LOCAL, rq("b"));
    await tick();
    assert.equal(asked.length, 2, "2 回目も聞く");
    asked[1]!.answer(false);
    const r = await second;
    assert.ok(errorOf(r));
    assert.equal(listed, 1);
  });

  it("serve が待つのをやめたら、聞くのをやめる", async () => {
    const { asked, ask } = asker();
    const w = createWindowRun([
      createClipboardCommands({ list: async () => entries, ask }),
    ]);
    const p = w.run(LOCAL, rq("a"));
    await tick();
    w.cancel(LOCAL, "a");
    assert.ok(errorOf(await p));
    assert.equal(asked[0]!.cancelled, true);
  });

  it("リモートの Machine の Pane の頼みは、聞かずに断る", async () => {
    const { asked, ask } = asker();
    const w = createWindowRun([
      createClipboardCommands({ list: async () => entries, ask }),
    ]);
    assert.ok(errorOf(await w.run("dev-vm", rq())));
    assert.equal(asked.length, 0);
  });
});
