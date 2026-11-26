import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  PaneOpenRequest,
  PaneOrigin,
  PaneRunRequest,
} from "../../infrastructure/rpc/protocol.ts";
import {
  addMachine,
  localNamed,
  machineNames,
  machineTarget,
  fromConfig,
  localInAllowPaneTo,
  paneRelayAllowed,
  renameMachine,
  unknownAllowPaneTo,
  type Machine,
} from "./machines.ts";
import { callerOrigin, createPaneRelay, type LocalGate } from "./paneRelay.ts";
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
  /** マシンごとの serverId（書かなければ "sid-" と行き先） */
  serverIds?: Record<string, string>;
  /** ssh 先のマシンから手元の PC への頼みを通すかを決めるもの */
  gate?: LocalGate;
  /** 人の答えを待てない（pane.relay.wait の無い）古い serve のマシン */
  cannotWait?: string;
  /** list の答えのペイン */
  panes?: unknown[];
  /** 答えない相手（runPane が終わらない）と、待つ時間 */
  hang?: boolean;
  waitMs?: number;
}) {
  const runs: { target: string; rq: PaneRunRequest }[] = [];
  const opens: { target: string; rq: PaneOpenRequest }[] = [];
  // pane.run に付けた、頼んだペインの名乗り（runs と同じ順）
  const froms: (PaneOrigin | undefined)[] = [];
  const session = (target: string) => ({
    connectedServerId: opts.serverIds?.[target] ?? `sid-${target}`,
    canWaitRelay: opts.cannotWait !== target,
    runPane: async (rq: PaneRunRequest, from?: PaneOrigin) => {
      if (opts.old) throw new Error("too old");
      runs.push({ target, rq });
      froms.push(from);
      if (opts.hang) return new Promise<never>(() => {});
      if (rq.cmd === "list" && opts.panes)
        return { ok: true, panes: opts.panes };
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
    ...(opts.gate ? { local: opts.gate } : {}),
    ...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
    openTab: async (target, rq) => {
      opens.push({ target, rq });
      return rq.workspace === "bad"
        ? { error: "no workspace" }
        : { termId: "t8" };
    },
  });
  return { relay, runs, opens, froms };
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
    // 手元の PC は、設定に local と書いてあっても中継しない。人が時間を決めて許している間（granted）だけ
    assert.ok(!paneRelayAllowed(allowLocal, "dev-vm", LOCAL));
    assert.ok(paneRelayAllowed(allowLocal, "dev-vm", LOCAL, true));
    assert.ok(paneRelayAllowed(machines, "dev-vm", LOCAL, true));
    assert.ok(!paneRelayAllowed(machines, "dev-vm", "build", true));
    assert.deepEqual(localInAllowPaneTo(allowLocal), ["dev"]);
    assert.deepEqual(localInAllowPaneTo(allowBuild), []);
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
        assert.match(
          r.error ?? "",
          to === "local" ? /machine dialog/ : /allow_pane_to/,
          `${rq.cmd} ${to}`,
        );
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
      /machine dialog/,
    );
    assert.deepEqual(t.runs, [{ target: "build", rq }]);

    // 設定に local と書いてあっても、手元の PC には中継しない
    const l = setup({ machines: allowLocal });
    assert.match(
      (
        await l.relay("dev-vm", "local", {
          cmd: "open-tab",
          workspace: "w",
          name: "a",
        })
      ).error ?? "",
      /machine dialog/,
    );
    assert.match(
      (await l.relay("dev-vm", "build", { cmd: "list" })).error ?? "",
      /allow_pane_to/,
    );
    assert.equal(l.opens.length, 0);
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

describe("頼んだペインの名乗り（届くペインの範囲を、相手の serve が決めるためのもの）", () => {
  const ids = { [LOCAL]: "sid-local", "dev-vm": "sid-dev", build: "sid-build" };

  it("頼みを送ってきた接続の serverId と、頼んだペインの id で名乗る", () => {
    assert.deepEqual(callerOrigin(ids, LOCAL, "t1"), {
      server: "sid-local",
      pane: "t1",
    });
    assert.deepEqual(callerOrigin(ids, "dev-vm", "t4"), {
      server: "sid-dev",
      pane: "t4",
    });
  });

  it("ペインの id が無い（古い serve）・つながっていないマシンは名乗らない", () => {
    assert.equal(callerOrigin(ids, "dev-vm", undefined), undefined);
    assert.equal(callerOrigin(ids, "dev-vm", ""), undefined);
    assert.equal(callerOrigin(ids, "gone", "t1"), undefined);
    assert.equal(
      callerOrigin({ ...ids, build: undefined }, "build", "t1"),
      undefined,
    );
  });

  it("ssh 先の serve が、ほかのマシンと同じ serverId を言うなら名乗らない。手元の PC は名乗る", () => {
    const forged = { ...ids, "dev-vm": "sid-local" };
    assert.equal(callerOrigin(forged, "dev-vm", "t1"), undefined);
    assert.deepEqual(callerOrigin(forged, LOCAL, "t1"), {
      server: "sid-local",
      pane: "t1",
    });
    const same = { ...ids, build: "sid-dev" };
    assert.equal(callerOrigin(same, "dev-vm", "t1"), undefined);
    assert.equal(callerOrigin(same, "build", "t1"), undefined);
  });

  it("pane.run に名乗りを付け、open-tab には系譜をそのまま渡す", async () => {
    const t = setup({});
    await t.relay(LOCAL, "dev", { cmd: "read", to: "foo" }, { pane: "t2" });
    assert.deepEqual(t.froms, [{ server: "sid-@local", pane: "t2" }]);
    const ancestry = [
      { server: "sid-@local", pane: "t1" },
      { server: "sid-@local", pane: "t2" },
    ];
    await t.relay(
      LOCAL,
      "dev",
      { cmd: "open-tab", workspace: "w", name: "a" },
      { pane: "t2", ancestry },
    );
    assert.deepEqual(t.opens[0].rq.ancestry, ancestry);
  });

  it("名乗れない送り元の頼みは、名乗りも系譜も付けずに送る（相手の serve が、どこにも届かせない）", async () => {
    const allow: Machine[] = [
      { target: "dev-vm", name: "dev", fixed: true, allowPaneTo: ["build"] },
      { target: "build" },
    ];
    // dev の serve が、build の serve と同じ serverId を言っている
    const t = setup({
      machines: allow,
      serverIds: { build: "same", "dev-vm": "same" },
    });
    await t.relay(
      "dev-vm",
      "build",
      { cmd: "read", to: "foo" },
      { pane: "t1" },
    );
    assert.deepEqual(t.froms, [undefined]);
    await t.relay(
      "dev-vm",
      "build",
      { cmd: "open-tab", workspace: "w", name: "a" },
      { pane: "t1", ancestry: [{ server: "same", pane: "t1" }] },
    );
    assert.equal(t.opens[0].rq.ancestry, undefined);
    // 古い serve（ペインの id を付けない）も同じ
    const old = setup({ machines: allow });
    await old.relay("dev-vm", "build", { cmd: "list" });
    assert.deepEqual(old.froms, [undefined]);
  });
});

describe("pane.relay・pane.open の、頼んだペインと系譜", () => {
  it("頼んだペインの id と、形の合う系譜だけを取り出す", () => {
    const got = parsePaneRelay({
      id: "r1",
      machine: "dev",
      pane: "t4",
      ancestry: [
        { server: "sid", pane: "t1" },
        { pane: "t4" },
        { server: 1, pane: "t5" },
        { server: "sid" },
        "x",
      ],
      request: { cmd: "open-tab", workspace: "w", name: "n" },
    });
    assert.equal(got?.pane, "t4");
    assert.deepEqual(got?.ancestry, [
      { server: "sid", pane: "t1" },
      { pane: "t4" },
      { pane: "t5" },
    ]);
    const old = parsePaneRelay({
      id: "r2",
      machine: "dev",
      request: { cmd: "list" },
    });
    assert.equal(old?.pane, undefined);
    assert.equal(old?.ancestry, undefined);
  });
});

describe("ssh 先のマシンから手元の PC への頼み（時間を決めた許可と、人への問い）", () => {
  type OpenAsk = Parameters<LocalGate["askOpen"]>[0];
  type OpAsk = Parameters<LocalGate["askOp"]>[0];
  /** 問いに answers の順で答える門。聞かれた中身と、「毎回聞く」にしたペインを覚える。 */
  function gateOf(o: {
    granted?: () => boolean;
    open?: ("allow" | "allow-ask" | "deny")[];
    op?: boolean[];
    each?: string[];
  }) {
    const asked: (OpenAsk | OpAsk)[] = [];
    const each = new Set(o.each ?? []);
    const gate: LocalGate = {
      granted: () => (o.granted ? o.granted() : true),
      askOpen: async (a) => {
        asked.push(a);
        return o.open?.shift() ?? "deny";
      },
      askOp: async (a) => {
        asked.push(a);
        return o.op?.shift() ?? false;
      },
      anyAskEach: () => each.size > 0,
      mustAskEach: (server, pane, from) =>
        [pane, ...from].some((p) => each.has(`${server}/${p}`)),
      markAskEach: (server, pane) => void each.add(`${server}/${pane}`),
    };
    return { gate, asked, each };
  }
  const open = {
    cmd: "open-tab",
    workspace: "w",
    new: true,
    name: "a",
    cwd: "/src",
    argv: ["/bin/sh", "-c", "echo hi"],
  };
  const by = { id: "r7", pane: "t4" };

  it("許していなければ、人に聞かずに断り、許し方を返す", async () => {
    const g = gateOf({ granted: () => false, open: ["allow"] });
    const t = setup({ gate: g.gate });
    for (const rq of [
      open,
      { cmd: "send", to: "a", text: "x" },
      { cmd: "list" },
    ]) {
      const r = await t.relay("dev-vm", "local", rq, by);
      assert.match(r.error ?? "", /machine dialog/, rq.cmd);
    }
    assert.equal(g.asked.length, 0);
    assert.equal(t.opens.length, 0);
    assert.equal(t.runs.length, 0);
  });

  it("ペインを作る頼みは、中身を全部見せて聞く。断ったら作らない", async () => {
    const g = gateOf({ open: ["deny"] });
    const t = setup({ gate: g.gate });
    const r = await t.relay("dev-vm", "local", open, by);
    assert.match(r.error ?? "", /did not allow/);
    assert.deepEqual(g.asked, [
      {
        kind: "open",
        id: "r7",
        from: "dev-vm",
        workspace: "w",
        isNew: true,
        name: "a",
        cwd: "/src",
        argv: ["/bin/sh", "-c", "echo hi"],
      },
    ]);
    assert.equal(t.opens.length, 0);
  });

  it("許したら手元の PC に作る。「毎回聞く」を選んだら、作ったペインを覚える", async () => {
    const g = gateOf({ open: ["allow", "allow-ask"] });
    const t = setup({ gate: g.gate });
    const ancestry = [{ server: "sid-dev-vm", pane: "t4" }];
    assert.deepEqual(
      await t.relay("dev-vm", "local", open, { ...by, ancestry }),
      { ok: true, id: "t8" },
    );
    assert.equal(t.opens[0].target, LOCAL);
    assert.deepEqual(t.opens[0].rq.ancestry, ancestry);
    assert.equal(g.each.size, 0);
    await t.relay("dev-vm", "local", open, { ...by, ancestry });
    assert.deepEqual([...g.each], ["sid-@local/t8"]);
  });

  it("「毎回聞く」ペインが無ければ、操作は聞かずに送る（名乗りを付ける）", async () => {
    const g = gateOf({});
    const t = setup({ gate: g.gate });
    const rq = { cmd: "send", to: "a", text: "echo hi" };
    assert.deepEqual(await t.relay("dev-vm", "local", rq, by), {
      ok: true,
      id: "t3",
    });
    assert.equal(g.asked.length, 0);
    assert.deepEqual(t.runs, [{ target: LOCAL, rq }]);
    assert.deepEqual(t.froms, [{ server: "sid-dev-vm", pane: "t4" }]);
  });

  it("「毎回聞く」ペインと、そこから作られたペインへの操作は、中身を見せて聞く。聞いたペインを id で指して送る", async () => {
    const panes = [
      { id: "t8", name: "a", openedFrom: [] },
      { id: "t9", name: "child", openedFrom: ["t8"] },
      { id: "t5", name: "other", openedFrom: [] },
    ];
    const g = gateOf({ each: ["sid-@local/t8"], op: [true, false, true] });
    const t = setup({ gate: g.gate, panes });
    // 「毎回聞く」ペイン：許す
    assert.deepEqual(
      await t.relay(
        "dev-vm",
        "local",
        { cmd: "send", to: "a", text: "ls" },
        by,
      ),
      { ok: true, id: "t3" },
    );
    // そこから作られたペイン：断る
    const no = await t.relay(
      "dev-vm",
      "local",
      { cmd: "keys", to: "child", keys: ["ctrl+c"] },
      by,
    );
    assert.match(no.error ?? "", /did not allow/);
    // 聞かないペイン：聞かずに送る
    await t.relay("dev-vm", "local", { cmd: "read", to: "other" }, by);
    assert.deepEqual(
      g.asked.map((a) =>
        a.kind === "op" ? [a.cmd, a.pane, a.text, a.keys] : a,
      ),
      [
        ["send", "a", "ls", undefined],
        ["keys", "child", undefined, ["ctrl+c"]],
      ],
    );
    assert.deepEqual(
      t.runs.filter((r) => r.rq.cmd !== "list").map((r) => r.rq),
      [
        { cmd: "send", to: "t8", text: "ls" },
        { cmd: "read", to: "other" },
      ],
    );
    // list は聞かない
    await t.relay("dev-vm", "local", { cmd: "list" }, by);
    assert.equal(g.asked.length, 2);
  });

  it("聞いている間に許可が終わったら、許すと答えても断る", async () => {
    let granted = true;
    const g = gateOf({ granted: () => granted });
    g.gate.askOpen = async () => {
      granted = false;
      return "allow";
    };
    const t = setup({ gate: g.gate });
    const r = await t.relay("dev-vm", "local", open, by);
    assert.match(r.error ?? "", /did not allow/);
    assert.equal(t.opens.length, 0);
  });

  it("人の答えを待てない古い serve・名乗れない頼みは、聞かずに断る", async () => {
    const g = gateOf({ open: ["allow"] });
    const old = setup({ gate: g.gate, cannotWait: "dev-vm" });
    assert.match(
      (await old.relay("dev-vm", "local", open, by)).error ?? "",
      /too old/,
    );
    const t = setup({ gate: g.gate });
    assert.match(
      (await t.relay("dev-vm", "local", open, { id: "r1" })).error ?? "",
      /too old/,
    );
    assert.equal(g.asked.length, 0);
  });

  it("相手のマシンが答えなければ、時間で断る", async () => {
    const t = setup({ hang: true, waitMs: 5 });
    const r = await t.relay(LOCAL, "dev", { cmd: "read", to: "x" }, by);
    assert.match(r.error ?? "", /did not answer in time/);
  });
});
