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
  fromConfig,
  paneRelayAllowed,
  renameMachine,
  unknownAllowPaneTo,
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
    // 設定ファイルの一覧から作ったものも
    assert.deepEqual(
      localNamed(
        fromConfig([
          { ssh: "a", name: "local" },
          { ssh: "local", local: true },
        ]),
      ),
      ["a", "local"],
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

function setup(opts: {
  connected?: boolean;
  old?: boolean;
  machines?: Machine[];
}) {
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
        ({
          [LOCAL]: session(LOCAL),
          "dev-vm": session("dev-vm"),
          build: session("build"),
        }) as never,
      states: () =>
        ({
          [LOCAL]: { kind: "connected" },
          build: { kind: "connected" },
          "dev-vm": {
            kind: opts.connected === false ? "connecting" : "connected",
          },
        }) as never,
      machines: () => opts.machines ?? machines,
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

describe("--machine の頼みの中継", () => {
  it("名前のマシンの serve に pane.run で送り、答えをそのまま返す", async () => {
    const t = setup({});
    const rq = { cmd: "send", to: "foo", text: "echo hi" };
    assert.deepEqual(await t.relay(LOCAL, " dev ", rq), { ok: true, id: "t3" });
    assert.deepEqual(await t.relay(LOCAL, "local", { cmd: "list" }), {
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
      await t.relay(LOCAL, "dev", {
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
      await t.relay(LOCAL, "dev", {
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
    const nope = await t.relay(LOCAL, "nope", { cmd: "list" });
    assert.match(nope.error ?? "", /nope/);
    assert.match(nope.error ?? "", /local, dev, build/);
    assert.match(
      (await t.relay(LOCAL, "dev", { cmd: "list" })).error ?? "",
      /dev/,
    );
    assert.deepEqual(
      await setup({ old: true }).relay(LOCAL, "dev", { cmd: "list" }),
      {
        error: "too old",
      },
    );
    assert.equal(t.runs.length, 0);
  });
});

describe("ssh 先のマシンからの --machine の頼み", () => {
  // dev は build にだけ届いてよい。build は allow_pane_to を書いていない
  const allowBuild: Machine[] = [
    { target: "dev-vm", name: "dev", fixed: true, allowPaneTo: ["build"] },
    { target: "build" },
  ];
  const allowLocal: Machine[] = [
    { target: "dev-vm", name: "dev", fixed: true, allowPaneTo: ["local"] },
    { target: "build" },
  ];

  it("手元の PC からは、どのマシンにも中継してよい。自分のマシンを指すのもよい", () => {
    assert.ok(paneRelayAllowed(machines, LOCAL, "dev-vm"));
    assert.ok(paneRelayAllowed(machines, LOCAL, "build"));
    assert.ok(paneRelayAllowed(machines, LOCAL, LOCAL));
    assert.ok(paneRelayAllowed(machines, "dev-vm", "dev-vm"));
    assert.ok(paneRelayAllowed(machines, "build", "build"));
  });

  it("ssh 先のマシンからは、allow_pane_to に名前のある先にだけ中継してよい", () => {
    // 書いていなければ、手元の PC にもほかのマシンにも中継しない
    assert.ok(!paneRelayAllowed(machines, "dev-vm", LOCAL));
    assert.ok(!paneRelayAllowed(machines, "dev-vm", "build"));
    assert.ok(!paneRelayAllowed(machines, "build", LOCAL));
    assert.ok(!paneRelayAllowed(machines, "build", "dev-vm"));
    // 一覧に無いマシン（つないだことの無い行き先）からも中継しない
    assert.ok(!paneRelayAllowed(machines, "unknown", LOCAL));
    assert.ok(paneRelayAllowed(allowBuild, "dev-vm", "build"));
    assert.ok(!paneRelayAllowed(allowBuild, "dev-vm", LOCAL));
    assert.ok(paneRelayAllowed(allowLocal, "dev-vm", LOCAL));
    assert.ok(!paneRelayAllowed(allowLocal, "dev-vm", "build"));
    // 許しは片方向（build から dev へは別に書く）
    assert.ok(!paneRelayAllowed(allowBuild, "build", "dev-vm"));
  });

  it("allow_pane_to は設定ファイルの一覧から付く（書いていなければ付かない。窓で足したばかりのマシンにも付かない）", () => {
    const list = fromConfig([
      { ssh: "dev-vm", name: "dev", allowPaneTo: ["build"] },
      { ssh: "ci", allowPaneTo: [] },
      { ssh: "build", local: true },
    ]);
    assert.deepEqual(list, [
      { target: "dev-vm", name: "dev", allowPaneTo: ["build"], fixed: true },
      { target: "ci", fixed: true },
      { target: "build" },
    ]);
    assert.ok(paneRelayAllowed(list, "dev-vm", "build"));
    assert.ok(!paneRelayAllowed(list, "ci", "build"));
    assert.ok(!paneRelayAllowed(list, "build", LOCAL));
  });

  it("allow_pane_to の、どのマシンの名前でもない語を知らせる", () => {
    assert.deepEqual(unknownAllowPaneTo(machines), []);
    assert.deepEqual(unknownAllowPaneTo(allowLocal), []);
    assert.deepEqual(
      unknownAllowPaneTo([
        {
          target: "dev-vm",
          name: "dev",
          fixed: true,
          // 名前でなく ssh の行き先で書いたもの（dev-vm）も、名前ではないので知らせる
          allowPaneTo: ["local", "buld", "build", "dev-vm"],
        },
        { target: "build" },
      ]),
      [{ machine: "dev", names: ["buld", "dev-vm"] }],
    );
  });

  it("許していない先への頼みは、何もせずに断る（open-tab・send・read・list のどれも）", async () => {
    const t = setup({});
    for (const rq of [
      {
        cmd: "open-tab",
        workspace: "w",
        new: true,
        name: "a",
        argv: ["/bin/sh"],
      },
      { cmd: "send", to: "foo", text: "echo hi" },
      { cmd: "read", to: "foo" },
      { cmd: "list" },
    ]) {
      for (const to of ["local", "build"]) {
        const r = await t.relay("dev-vm", to, rq);
        assert.match(r.error ?? "", /allow_pane_to/, `${rq.cmd} ${to}`);
        assert.equal(r.ok, undefined);
      }
    }
    assert.equal(t.runs.length, 0);
    assert.equal(t.opens.length, 0);
  });

  it("断るときは、その名前のマシンがあるかも、マシンの名前の一覧も教えない", async () => {
    const t = setup({});
    const nope = await t.relay("dev-vm", "nope", { cmd: "list" });
    const build = await t.relay("dev-vm", "build", { cmd: "list" });
    assert.match(nope.error ?? "", /allow_pane_to/);
    assert.equal(
      nope.error?.replaceAll("nope", "build"),
      build.error,
      "無い名前と、許していない名前で、同じ文を返す",
    );
    assert.doesNotMatch(build.error ?? "", /local, dev, build/);
  });

  it("許した先には中継する。許していない先は断る", async () => {
    const t = setup({ machines: allowBuild });
    const rq = { cmd: "send", to: "foo", text: "echo hi" };
    assert.deepEqual(await t.relay("dev-vm", "build", rq), {
      ok: true,
      id: "t3",
    });
    assert.match(
      (await t.relay("dev-vm", "local", rq)).error ?? "",
      /allow_pane_to/,
    );
    assert.deepEqual(t.runs, [{ target: "build", rq }]);

    const l = setup({ machines: allowLocal });
    assert.deepEqual(
      await l.relay("dev-vm", "local", {
        cmd: "open-tab",
        workspace: "w",
        name: "a",
      }),
      { ok: true, id: "t8" },
    );
    assert.equal(l.opens[0].target, LOCAL);
    assert.match(
      (await l.relay("dev-vm", "build", { cmd: "list" })).error ?? "",
      /allow_pane_to/,
    );
    assert.equal(l.runs.length, 0);
  });

  it("自分のマシンを指した頼みは、書いていなくても通す", async () => {
    const t = setup({});
    assert.deepEqual(await t.relay("dev-vm", "dev", { cmd: "list" }), {
      ok: true,
      id: "t3",
    });
    assert.deepEqual(t.runs, [{ target: "dev-vm", rq: { cmd: "list" } }]);
  });
});
