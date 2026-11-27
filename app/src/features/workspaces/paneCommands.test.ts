import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WindowCommandError,
  type WindowCaller,
} from "../commands/windowRun.ts";
import {
  machineTarget,
  paneRelayAllowed,
  type Machine,
} from "../sessions/machines.ts";
import { LOCAL } from "../sessions/shell.ts";
import type { PaneLayout } from "../../infrastructure/rpc/protocol.ts";
import type { TermGroup, TermGroups } from "../terminal/group.ts";
import { termKey, type GwsState } from "./model.ts";
import { createPaneCommands, MAX_RESIZE_STEPS } from "./paneCommands.ts";
import type { Row } from "./rows.ts";

// ws1 に手元の PC の Terminal tab（wlocal）と dev の Terminal tab（wdev）、review に build の Terminal tab（wbuild）
const state: GwsState = {
  list: [
    {
      id: "gaaaaaaaaaa",
      name: "",
      num: 1,
      tabs: [
        { kind: "term", target: LOCAL, ws: "wlocal", title: "" },
        { kind: "term", target: "dev-vm", ws: "wdev", title: "" },
      ],
    },
    {
      id: "gbbbbbbbbbb",
      name: "review",
      num: 2,
      tabs: [{ kind: "term", target: "build", ws: "wbuild", title: "" }],
    },
  ],
};

const row = (
  gws: string,
  shown: string | undefined,
  items: [string, string][],
  focused = false,
): Row =>
  ({
    gws,
    band: { focused },
    tabs: {
      shown,
      focused,
      items: items.map(([key, title]) => ({ key, title })),
    },
  }) as unknown as Row;

/** 今いるのは ws1 で、キーが向いているのは shown1。 */
const rowsOn = (shown1: string): Row[] => [
  row(
    "gaaaaaaaaaa",
    shown1,
    [
      [termKey(LOCAL, "wlocal"), "repo"],
      [termKey("dev-vm", "wdev"), "repo"],
    ],
    true,
  ),
  row("gbbbbbbbbbb", termKey("build", "wbuild"), [
    [termKey("build", "wbuild"), "ci"],
  ]),
];

const machines: Machine[] = [
  { target: "dev-vm", name: "dev", allowPaneTo: ["build"] },
  { target: "build" },
];

/** Machine ごとの、serve が答える Pane の一覧（届く Pane だけ。serve が pane_reach で絞ったもの）。 */
const panesOf: Record<string, { id: string; name?: string; tab: string }[]> = {
  [LOCAL]: [{ id: "t1", name: "main", tab: "wlocal" }],
  "dev-vm": [
    { id: "t7", name: "worker", tab: "wdev" },
    { id: "t8", tab: "wdev" },
  ],
  build: [{ id: "t9", name: "ci", tab: "wbuild" }],
};

/** 分割の木：左 a（上 a1・下 a2）・右 b。 */
const layout: PaneLayout = {
  dir: "right",
  ratio: 0.5,
  a: {
    dir: "down",
    ratio: 0.5,
    a: { pane: "a1" },
    b: { pane: "a2" },
  },
  b: { pane: "b" },
};

function setup(
  opts: {
    granted?: boolean;
    down?: string[];
    zoomed?: boolean;
    noShj?: boolean;
    previous?: boolean;
    rows?: Row[];
  } = {},
) {
  const calls: unknown[][] = [];
  const group = {
    list: [{ id: "a1" }, { id: "a2" }, { id: "b" }],
    activatePane: (id: string) => {
      calls.push(["activatePane", id]);
      return id !== "gone";
    },
    focusPrevious: () => {
      calls.push(["focusPrevious"]);
      return opts.previous !== false;
    },
    swap: (dir: string, pane: string) => {
      calls.push(["swap", dir, pane]);
      return dir !== "up";
    },
    resizeToward: (pane: string, dir: string, steps: number) => {
      calls.push(["resize", pane, dir, steps]);
      return dir !== "up";
    },
  } as unknown as TermGroup;
  const termGroups = new Map<string, TermGroups>(
    [LOCAL, "dev-vm", "build"].map((t) => [
      t,
      {
        get: (ws: string) => (ws.startsWith("w") ? group : undefined),
      } as never,
    ]),
  );
  const table = createPaneCommands({
    sessions: {
      states: () =>
        Object.fromEntries(
          [LOCAL, "dev-vm", "build"].map((t) => [
            t,
            opts.down?.includes(t)
              ? { kind: "disconnected" }
              : { kind: "connected" },
          ]),
        ) as never,
      machines: () => machines,
      labelOf: (t) => (t === LOCAL ? "Local" : t),
    },
    termGroups,
    gws: () => state,
    rows: () => opts.rows ?? rowsOn(termKey(LOCAL, "wlocal")),
    tabs: { activateTab: (gid, ref) => calls.push(["show", gid, ref.kind]) },
    terminals: {
      isZoomed: () => opts.zoomed === true,
      canZoomWs: () => opts.noShj !== true,
      zoomWs: (target, id, on) => {
        calls.push(["zoomWs", target, id, on]);
        return on === "toggle" ? !opts.zoomed : on;
      },
    },
    relay: async (from, machine, rq, by) => {
      calls.push(["relay", from, machine, rq.cmd, by.pane]);
      const target = machineTarget(machines, machine);
      if (
        target === undefined ||
        !paneRelayAllowed(machines, from, target, opts.granted === true)
      )
        return { error: `refused ${machine}` };
      return { ok: true, panes: panesOf[target] };
    },
    granted: () => opts.granted === true,
  });
  const run = (
    command: string,
    args: Record<string, unknown>,
    from = LOCAL,
    tab = "wlocal",
  ) =>
    table[command].run(args, {
      from,
      pane: from === LOCAL ? "t1" : "t7",
      tab,
      signal: new AbortController().signal,
    } satisfies WindowCaller);
  return { calls, run, table };
}

async function refusal(p: () => unknown): Promise<WindowCommandError> {
  try {
    await p();
  } catch (e) {
    assert.ok(e instanceof WindowCommandError, String(e));
    return e;
  }
  assert.fail("not refused");
}

describe("kisui pane focus・swap・zoom・resize の受け持ち", () => {
  it("どれもリモートの Machine の Pane の頼みを受ける印（remote）が付いている", () => {
    const { table } = setup();
    assert.deepEqual(Object.keys(table).sort(), [
      "pane.focus",
      "pane.last",
      "pane.resize",
      "pane.swap",
      "pane.zoom",
    ]);
    for (const c of Object.values(table)) assert.equal(c.remote, true);
  });
});

describe("kisui pane focus", () => {
  it("手元の PC の Pane からは、名前か id で指した Pane の Tab を表示して、その Pane にキーを向ける", async () => {
    const { run, calls } = setup();
    assert.deepEqual(
      await run("pane.focus", { pane: "worker", machine: "dev" }),
      {
        id: "t7",
      },
    );
    assert.deepEqual(calls, [
      ["relay", LOCAL, "dev", "list", "t1"],
      ["zoomWs", "dev-vm", "wdev", false],
      ["activatePane", "t7"],
      ["show", "gaaaaaaaaaa", "term"],
    ]);
    const again = setup();
    await again.run("pane.focus", { pane: "t8", machine: "dev" });
    assert.ok(
      again.calls.some((c) => c[0] === "activatePane" && c[1] === "t8"),
    );
  });

  it("machine を省くと、頼んだ Pane の Machine の Pane を指す", async () => {
    const { run, calls } = setup();
    await run("pane.focus", { pane: "main" });
    assert.deepEqual(calls[0], ["relay", LOCAL, "local", "list", "t1"]);
    const dev = setup({ rows: rowsOn(termKey("dev-vm", "wdev")) });
    await dev.run("pane.focus", { pane: "worker" }, "dev-vm", "wdev");
    assert.deepEqual(dev.calls[0], ["relay", "dev-vm", "dev", "list", "t7"]);
  });

  it("届かない Pane・無い Pane は、同じ文で断る", async () => {
    const { run } = setup();
    const a = await refusal(() => run("pane.focus", { pane: "nobody" }));
    assert.ok(a.message.includes('"nobody"'));
    const b = await refusal(() =>
      run("pane.focus", { pane: "t99", machine: "local" }),
    );
    assert.equal(b.message.replace("t99", "nobody"), a.message);
  });

  it("中継が断った Machine（許していない・名前が違う）は、中継の理由で断る", async () => {
    const { run } = setup();
    const e = await refusal(() =>
      run("pane.focus", { pane: "main", machine: "local" }, "dev-vm", "wdev"),
    );
    assert.equal(e.message, "refused local");
    const none = await refusal(() =>
      run("pane.focus", { pane: "x", machine: "nope" }),
    );
    assert.equal(none.message, "refused nope");
  });

  it("つながっていない Machine の Pane は断る", async () => {
    const { run } = setup({ down: ["dev-vm"] });
    const e = await refusal(() =>
      run("pane.focus", { pane: "worker", machine: "dev" }),
    );
    assert.ok(e.message.includes("dev-vm"));
  });

  it("許していないリモートの Machine の Pane は、キーがその Machine の Terminal tab に向いていなければ通らない", async () => {
    const { run, calls } = setup();
    const e = await refusal(() =>
      run("pane.focus", { pane: "worker" }, "dev-vm", "wdev"),
    );
    assert.ok(e.message.includes("dev-vm"));
    assert.ok(!calls.some((c) => c[0] === "show"));
  });

  it("キーがその Machine の Terminal tab に向いていれば、その Machine の Pane へ移れる。ほかの Machine の Pane へは移れない", async () => {
    const rows = rowsOn(termKey("dev-vm", "wdev"));
    const { run, calls } = setup({ rows });
    await run("pane.focus", { pane: "t8" }, "dev-vm", "wdev");
    assert.ok(calls.some((c) => c[0] === "show"));
    const other = setup({ rows });
    const e = await refusal(() =>
      other.run(
        "pane.focus",
        { pane: "ci", machine: "build" },
        "dev-vm",
        "wdev",
      ),
    );
    assert.ok(e.message.includes("dev-vm"));
    assert.ok(!other.calls.some((c) => c[0] === "show"));
  });

  it("手元の PC の操作を許している間は、リモートの Machine の Pane も、どの Pane にも移れる", async () => {
    const { run, calls } = setup({ granted: true });
    await run(
      "pane.focus",
      { pane: "main", machine: "local" },
      "dev-vm",
      "wdev",
    );
    assert.ok(calls.some((c) => c[0] === "show"));
  });

  it("Sidebar に出ていない Tab の Pane は断る", async () => {
    const { run } = setup({ rows: [] });
    await refusal(() => run("pane.focus", { pane: "main" }));
  });

  it("Pane が一覧から消えていれば断る", async () => {
    const { run } = setup();
    panesOf[LOCAL].push({ id: "gone", tab: "wlocal" });
    try {
      await refusal(() => run("pane.focus", { pane: "gone" }));
    } finally {
      panesOf[LOCAL].pop();
    }
  });
});

describe("kisui pane focus --last", () => {
  it("頼んだ Pane の Tab で、1 つ前の Pane に戻り、その Tab を表示する", async () => {
    const { run, calls } = setup();
    assert.deepEqual(await run("pane.last", {}), { moved: true });
    assert.deepEqual(calls, [
      ["focusPrevious"],
      ["show", "gaaaaaaaaaa", "term"],
    ]);
  });

  it("1 つ前の Pane が無ければ、何も動かさない", async () => {
    const { run, calls } = setup({ previous: false });
    assert.deepEqual(await run("pane.last", {}), { moved: false });
    assert.deepEqual(calls, [["focusPrevious"]]);
  });

  it("隠している間は断る", async () => {
    const { run } = setup({ zoomed: true });
    const e = await refusal(() => run("pane.last", {}));
    assert.ok(e.message.includes("kisui pane zoom"));
  });

  it("許していないリモートの Machine の Pane は、キーがその Machine の Terminal tab に向いているときだけ", async () => {
    const off = setup();
    await refusal(() => off.run("pane.last", {}, "dev-vm", "wdev"));
    const on = setup({ rows: rowsOn(termKey("dev-vm", "wdev")) });
    assert.deepEqual(await on.run("pane.last", {}, "dev-vm", "wdev"), {
      moved: true,
    });
  });
});

describe("kisui pane swap", () => {
  it("指した Pane と隣を入れ替え、動いたかを返す。キーは動かさない", async () => {
    const { run, calls } = setup();
    assert.deepEqual(
      await run("pane.swap", { pane: "worker", machine: "dev", dir: "left" }),
      { id: "t7", moved: true },
    );
    assert.deepEqual(calls.at(-1), ["swap", "left", "t7"]);
    assert.ok(!calls.some((c) => c[0] === "show"));
    assert.deepEqual(await run("pane.swap", { pane: "main", dir: "up" }), {
      id: "t1",
      moved: false,
    });
  });

  it("向きが違えば断る。隠している間は断る", async () => {
    await refusal(() =>
      setup().run("pane.swap", { pane: "main", dir: "sideways" }),
    );
    await refusal(() => setup().run("pane.swap", { pane: "main" }));
    const e = await refusal(() =>
      setup({ zoomed: true }).run("pane.swap", { pane: "main", dir: "left" }),
    );
    assert.ok(e.message.includes("kisui pane zoom"));
  });

  it("リモートの Machine の Pane は、許した Machine の Pane を入れ替えられ、キーが向いていなくても通る（キーを動かさない）", async () => {
    const { run } = setup();
    assert.deepEqual(
      await run(
        "pane.swap",
        { pane: "ci", machine: "build", dir: "right" },
        "dev-vm",
        "wdev",
      ),
      { id: "t9", moved: true },
    );
    await refusal(() =>
      run(
        "pane.swap",
        { pane: "main", machine: "local", dir: "right" },
        "dev-vm",
        "wdev",
      ),
    );
  });
});

describe("kisui pane zoom", () => {
  it("切り替えて、今の状態を返す", async () => {
    const on = setup();
    assert.deepEqual(await on.run("pane.zoom", { pane: "main" }), {
      id: "t1",
      zoomed: true,
    });
    assert.deepEqual(on.calls.at(-1), ["zoomWs", LOCAL, "wlocal", "toggle"]);
    assert.deepEqual(
      await setup({ zoomed: true }).run("pane.zoom", { pane: "main" }),
      {
        id: "t1",
        zoomed: false,
      },
    );
  });

  it("プライマリで shj が動いていなければ断る。キーは動かさない", async () => {
    const { run, calls } = setup({ noShj: true });
    const e = await refusal(() => run("pane.zoom", { pane: "main" }));
    assert.ok(e.message.includes("shj"));
    assert.ok(!calls.some((c) => c[0] === "show"));
  });

  it("キーが向いている Terminal tab を Primary pane だけの表示にするときは、キーの行き先を変える頼みと同じ確認をする", async () => {
    const keysOnBuild = [
      row("gaaaaaaaaaa", termKey(LOCAL, "wlocal"), [
        [termKey(LOCAL, "wlocal"), "repo"],
      ]),
      row(
        "gbbbbbbbbbb",
        termKey("build", "wbuild"),
        [[termKey("build", "wbuild"), "ci"]],
        true,
      ),
    ];
    const zoomCi = (o: Parameters<typeof setup>[0], from = "dev-vm") => {
      const f = setup(o);
      return {
        f,
        r: () =>
          f.run("pane.zoom", { pane: "ci", machine: "build" }, from, "wdev"),
      };
    };
    // キーが build の Terminal tab にあるとき、dev の Pane からの build の Pane の zoom は断られ、zoomWs は呼ばれない
    const a = zoomCi({ rows: keysOnBuild });
    const e = await refusal(a.r);
    assert.ok(e.message.includes("dev-vm"));
    assert.ok(!a.f.calls.some((c) => c[0] === "zoomWs"));
    // 表示を戻すときは、キーを動かさないので通る
    assert.deepEqual(await zoomCi({ rows: keysOnBuild, zoomed: true }).r(), {
      id: "t9",
      zoomed: false,
    });
    // キーが向いていない Terminal tab（キーは手元の PC の Tab にある）は通る
    assert.deepEqual(await zoomCi({}).r(), { id: "t9", zoomed: true });
    // 許している間は通る
    assert.deepEqual(await zoomCi({ rows: keysOnBuild, granted: true }).r(), {
      id: "t9",
      zoomed: true,
    });
    // 手元の PC の Pane は、いつでも通る
    const local = setup({ rows: keysOnBuild });
    assert.deepEqual(
      await local.run("pane.zoom", { pane: "ci", machine: "build" }),
      { id: "t9", zoomed: true },
    );
    // キーがその Pane の Machine の Terminal tab にあれば、その Machine の Pane の zoom は通る
    const own = setup({ rows: rowsOn(termKey("dev-vm", "wdev")) });
    assert.deepEqual(
      await own.run("pane.zoom", { pane: "worker" }, "dev-vm", "wdev"),
      { id: "t7", zoomed: true },
    );
  });

  it("許していない Machine の Pane は断る", async () => {
    await refusal(() =>
      setup().run(
        "pane.zoom",
        { pane: "main", machine: "local" },
        "dev-vm",
        "wdev",
      ),
    );
  });
});

describe("kisui pane resize", () => {
  it("向きと回数を渡して、動いたかを返す", async () => {
    const { run, calls } = setup();
    assert.deepEqual(
      await run("pane.resize", { pane: "main", dir: "right", steps: 5 }),
      { id: "t1", moved: true },
    );
    assert.deepEqual(calls.at(-1), ["resize", "t1", "right", 5]);
    assert.deepEqual(
      await run("pane.resize", { pane: "main", dir: "up", steps: 1 }),
      { id: "t1", moved: false },
    );
  });

  it("回数が 1 から上限の整数でなければ断る。隠している間は断る", async () => {
    for (const steps of [0, -1, 1.5, MAX_RESIZE_STEPS + 1, "3", undefined])
      await refusal(() =>
        setup().run("pane.resize", { pane: "main", dir: "right", steps }),
      );
    await refusal(() =>
      setup({ zoomed: true }).run("pane.resize", {
        pane: "main",
        dir: "right",
        steps: 2,
      }),
    );
  });
});
