import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  PaneOpenRequest,
  PaneRunRequest,
} from "../../infrastructure/rpc/protocol.ts";
import {
  addMachine,
  localNamed,
  machineNames,
  machineTarget,
  mergeMachines,
  renameMachine,
  type Machine,
} from "./machines.ts";
import { createPaneRelay } from "./paneRelay.ts";
import { parsePaneRelay } from "./session.ts";
import { LOCAL } from "./shell.ts";

const machines: Machine[] = [
  { target: "dev-vm", name: "dev", fixed: true },
  { target: "build" },
];

describe("--machine のマシンの名前", () => {
  it("local は手元の PC。ほかは付けた名前、無ければ ssh の行き先", () => {
    assert.equal(machineTarget(machines, "local"), LOCAL);
    assert.equal(machineTarget(machines, "dev"), "dev-vm");
    assert.equal(machineTarget(machines, "build"), "build");
    assert.equal(machineTarget(machines, "dev-vm"), undefined);
    assert.equal(machineTarget(machines, "nope"), undefined);
    assert.deepEqual(machineNames(machines), ["local", "dev", "build"]);
  });

  it("名前が local のマシンは選べず、名前の一覧にも出さない", () => {
    const list: Machine[] = [{ target: "pc", name: "local", fixed: true }];
    assert.equal(machineTarget(list, "local"), LOCAL);
    assert.deepEqual(machineNames(list), ["local"]);
  });

  it("名前が local のマシンを知らせる（名前が無ければ ssh の行き先で見る。設定ファイルのものも、GUI で足したものも）", () => {
    assert.deepEqual(
      localNamed([
        { target: "a", name: "local", fixed: true },
        { target: "local" },
        { target: "local2", name: "other" },
        { target: "b" },
      ]),
      ["a", "local"],
    );
    // 設定ファイルのマシンの名前と同じ名前の足したマシンは出ない（mergeMachines）ので、知らせにも出ない
    assert.deepEqual(
      localNamed(
        mergeMachines([{ ssh: "a", name: "local" }], [{ target: "local" }]),
      ),
      ["a"],
    );
  });

  it("GUI で足す・名前を変えるときも local は断る", () => {
    assert.ok("error" in addMachine([], "pc", "local"));
    assert.ok("error" in addMachine([], "local"));
    assert.ok("machines" in addMachine([], "local", "home"));
    assert.ok("error" in renameMachine([{ target: "pc" }], "pc", "local"));
    assert.ok(
      "error" in renameMachine([{ target: "local", name: "x" }], "local", ""),
    );
  });
});

describe("pane.relay の中身", () => {
  it("形が合えば、知っている項目だけを取り出す", () => {
    assert.deepEqual(
      parsePaneRelay({
        id: "r1",
        machine: "dev",
        request: { cmd: "send", to: "foo", text: "hi", other: 1 },
      }),
      {
        id: "r1",
        machine: "dev",
        request: { cmd: "send", to: "foo", text: "hi" },
      },
    );
    assert.deepEqual(
      parsePaneRelay({
        id: "r2",
        machine: "dev",
        request: {
          cmd: "open-tab",
          workspace: "w",
          new: true,
          name: "n",
          argv: ["/bin/sh"],
        },
      })?.request,
      {
        cmd: "open-tab",
        workspace: "w",
        new: true,
        name: "n",
        argv: ["/bin/sh"],
      },
    );
  });

  it("形が違えば undefined", () => {
    for (const n of [
      null,
      { machine: "dev", request: { cmd: "list" } },
      { id: "r", request: { cmd: "list" } },
      { id: "r", machine: "dev" },
      { id: "r", machine: "dev", request: { to: "x" } },
      { id: "r", machine: "dev", request: { cmd: "keys", keys: [1] } },
      { id: "r", machine: "dev", request: { cmd: "read", lines: "3" } },
    ])
      assert.equal(parsePaneRelay(n), undefined, JSON.stringify(n));
  });
});

describe("--machine の頼みの中継", () => {
  function setup(opts: { connected?: boolean; old?: boolean }) {
    const runs: { target: string; rq: PaneRunRequest }[] = [];
    const opens: { target: string; rq: PaneOpenRequest }[] = [];
    const session = (target: string) => ({
      runPane: async (rq: PaneRunRequest) => {
        if (opts.old) throw new Error("too old");
        runs.push({ target, rq });
        return { ok: true, id: "t3" };
      },
    });
    const relay = createPaneRelay({
      sessions: {
        sessions: () =>
          ({ [LOCAL]: session(LOCAL), "dev-vm": session("dev-vm") }) as never,
        states: () =>
          ({
            [LOCAL]: { kind: "connected" },
            "dev-vm": {
              kind: opts.connected === false ? "connecting" : "connected",
            },
          }) as never,
        machines: () => machines,
        labelOf: (t: string) => (t === "dev-vm" ? "dev" : t),
      },
      openTab: async (target, rq) => {
        opens.push({ target, rq });
        return rq.workspace === "bad"
          ? { error: "no workspace" }
          : { termId: "t8" };
      },
    });
    return { relay, runs, opens };
  }

  it("名前のマシンの serve に pane.run で送り、答えをそのまま返す", async () => {
    const t = setup({});
    const rq = { cmd: "send", to: "foo", text: "echo hi" };
    assert.deepEqual(await t.relay(" dev ", rq), { ok: true, id: "t3" });
    assert.deepEqual(await t.relay("local", { cmd: "list" }), {
      ok: true,
      id: "t3",
    });
    assert.deepEqual(t.runs, [
      { target: "dev-vm", rq },
      { target: LOCAL, rq: { cmd: "list" } },
    ]);
  });

  it("open-tab は、そのマシンにタブを開く（フォルダが無ければ始めのフォルダ）", async () => {
    const t = setup({});
    assert.deepEqual(
      await t.relay("dev", {
        cmd: "open-tab",
        workspace: "w",
        new: true,
        name: "a",
        argv: ["/bin/claude"],
      }),
      { ok: true, id: "t8" },
    );
    assert.deepEqual(t.opens, [
      {
        target: "dev-vm",
        rq: {
          id: "",
          workspace: "w",
          name: "a",
          dir: "",
          new: true,
          argv: ["/bin/claude"],
        },
      },
    ]);
    assert.deepEqual(
      await t.relay("dev", {
        cmd: "open-tab",
        workspace: "bad",
        name: "a",
        cwd: "/src",
      }),
      { error: "no workspace" },
    );
    assert.equal(t.opens[1].rq.dir, "/src");
    assert.equal(t.runs.length, 0);
  });

  it("無いマシン・つながっていないマシン・古い serve は、理由を返す", async () => {
    const t = setup({ connected: false });
    const nope = await t.relay("nope", { cmd: "list" });
    assert.match(nope.error ?? "", /nope/);
    assert.match(nope.error ?? "", /local, dev, build/);
    assert.match((await t.relay("dev", { cmd: "list" })).error ?? "", /dev/);
    assert.deepEqual(await setup({ old: true }).relay("dev", { cmd: "list" }), {
      error: "too old",
    });
    assert.equal(t.runs.length, 0);
  });
});
