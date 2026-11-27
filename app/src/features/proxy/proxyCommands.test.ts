import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WindowRunReport } from "../../infrastructure/rpc/protocol.ts";

import { createWindowRun } from "../commands/windowRun.ts";
import { LOCAL } from "../sessions/shell.ts";
import {
  browserKey,
  dbKey,
  termKey,
  type GwsState,
  type TabRef,
} from "../workspaces/model.ts";
import type { Row } from "../workspaces/rows.ts";
import type { ProxyFail, ProxySubject } from "./controller.ts";
import { createProxyCommands } from "./proxyCommands.ts";

/** 答えの、断りの理由（行えたなら undefined）。 */
const errorOf = (r: WindowRunReport) => ("error" in r ? r.error : undefined);

// Workspace 1 つに、手元の PC の Terminal tab が 2 つ（同じ名前）・Browser tab・Database tab
const state: GwsState = {
  list: [
    {
      id: "gaaaaaaaaaa",
      name: "",
      num: 1,
      tabs: [
        { kind: "term", target: LOCAL, ws: "w1", title: "" },
        { kind: "term", target: LOCAL, ws: "w2", title: "" },
        { kind: "browser", id: "tpage" },
        { kind: "db", id: "dbmain", target: LOCAL, connection: "main" },
      ],
    },
  ],
};
const rows = [
  {
    gws: "gaaaaaaaaaa",
    tabs: {
      shown: termKey(LOCAL, "w1"),
      focused: true,
      items: [
        { key: termKey(LOCAL, "w1"), title: "repo" },
        { key: termKey(LOCAL, "w2"), title: "repo" },
        { key: browserKey("tpage"), title: "Docs" },
        { key: dbKey("dbmain"), title: "main" },
      ],
    },
  },
] as unknown as Row[];

function setup(opts: { fail?: string } = {}) {
  const calls: unknown[][] = [];
  const on = new Set<string>();
  const subjectOf = (ref: TabRef): ProxySubject | undefined =>
    ref.kind === "db"
      ? undefined
      : {
          kind: ref.kind === "term" ? "term" : "browser",
          target: LOCAL,
          scope: ref.kind === "term" ? `ws:${ref.ws}` : `b:${ref.id}`,
          tab:
            ref.kind === "term" ? termKey(LOCAL, ref.ws) : browserKey(ref.id),
        };
  const act =
    (name: string, f: (s: ProxySubject) => void) =>
    async (s: ProxySubject, ...rest: unknown[]) => {
      calls.push([
        name,
        s.scope,
        ...rest.filter((r) => typeof r !== "function"),
      ]);
      if (opts.fail) {
        const fail = rest.find((r) => typeof r === "function") as ProxyFail;
        fail({ title: "Cannot use the proxy here", error: opts.fail });
        return false;
      }
      f(s);
      return true;
    };
  const table = createProxyCommands({
    proxy: {
      subjectOf,
      openPanelOf: act("panel", (s) => on.add(s.scope)),
      closePanelOf: (s) => {
        calls.push(["close", s.scope]);
        return true;
      },
      stopOf: act("stop", (s) => on.delete(s.scope)),
      holdOf: act("hold", () => {}),
      stateOf: (s) =>
        on.has(s.scope) ? { port: 40000, holding: false } : undefined,
    },
    gws: () => state,
    rows: () => rows,
  });
  const w = createWindowRun([table]);
  const run = (command: string, args: Record<string, unknown>, from = LOCAL) =>
    w.run(from, { id: "x", pane: "t1", tab: "w1", command, args });
  return { calls, run };
}

describe("kisui proxy panel・close・stop・hold（#517）", () => {
  it("id か名前で指した Tab に、キー操作と同じ操作をし、今の状態を返す", async () => {
    const { calls, run } = setup();
    assert.deepEqual(await run("proxy.panel", { tab: "w2" }), {
      result: { id: "w2", on: true, holding: false },
    });
    assert.deepEqual(await run("proxy.hold", { tab: "Docs" }), {
      result: { id: "tpage", on: false, holding: false },
    });
    await run("proxy.hold", { tab: "w2", off: true });
    await run("proxy.close", { tab: "w2" });
    assert.deepEqual(await run("proxy.stop", { tab: "w2" }), {
      result: { id: "w2", on: false, holding: false },
    });
    assert.deepEqual(calls, [
      ["panel", "ws:w2"],
      ["hold", "b:tpage", true],
      ["hold", "ws:w2", false],
      ["close", "ws:w2"],
      ["stop", "ws:w2"],
    ]);
  });

  it("無い・2 つ以上に当たる・Database tab は、何もせずに断る", async () => {
    const { calls, run } = setup();
    assert.match(
      errorOf(await run("proxy.panel", { tab: "nope" })) ?? "",
      /nope/,
    );
    assert.match(
      errorOf(await run("proxy.panel", { tab: "repo" })) ?? "",
      /w1, w2/,
    );
    assert.ok(errorOf(await run("proxy.panel", { tab: "main" })));
    assert.ok(errorOf(await run("proxy.panel", {})));
    assert.deepEqual(calls, []);
  });

  it("できなかった理由を、そのまま返す", async () => {
    const { run } = setup({ fail: "This tab is not sent through the proxy." });
    assert.equal(
      errorOf(await run("proxy.stop", { tab: "w1" })),
      "This tab is not sent through the proxy.",
    );
  });

  it("リモートの Machine の Pane の頼みは断る", async () => {
    const { calls, run } = setup();
    for (const c of ["proxy.panel", "proxy.close", "proxy.stop", "proxy.hold"])
      assert.ok(errorOf(await run(c, { tab: "w1" }, "dev-vm")));
    assert.deepEqual(calls, []);
  });
});
