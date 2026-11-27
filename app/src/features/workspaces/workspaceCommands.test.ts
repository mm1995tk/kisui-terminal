import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WindowCommandError,
  type WindowCaller,
} from "../commands/windowRun.ts";
import type { Machine } from "../sessions/machines.ts";
import { LOCAL } from "../sessions/shell.ts";
import { browserKey, termKey, type GwsState } from "./model.ts";
import type { Row } from "./rows.ts";
import { createWorkspaceCommands } from "./workspaceCommands.ts";

// ws1 に手元の PC の Terminal tab・dev の Terminal tab・Browser tab、review に build の Terminal tab、empty は Tab が無い、
// devonly は dev の Terminal tab だけ
const state: GwsState = {
  list: [
    {
      id: "gaaaaaaaaaa",
      name: "",
      num: 1,
      tabs: [
        { kind: "term", target: LOCAL, ws: "wlocal", title: "" },
        { kind: "term", target: "dev-vm", ws: "wdev", title: "" },
        { kind: "browser", id: "tpage" },
      ],
    },
    {
      id: "gbbbbbbbbbb",
      name: "review",
      num: 2,
      tabs: [{ kind: "term", target: "build", ws: "wbuild", title: "" }],
    },
    { id: "gcccccccccc", name: "empty", num: 3, tabs: [] },
    {
      id: "gdddddddddd",
      name: "devonly",
      num: 4,
      tabs: [{ kind: "term", target: "dev-vm", ws: "wdev2", title: "" }],
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

/** 今いるのは ws1 で、表示している（キーが向いている）のは shown1。 */
const rowsOn = (shown1: string): Row[] => [
  row(
    "gaaaaaaaaaa",
    shown1,
    [
      [termKey(LOCAL, "wlocal"), "repo"],
      [termKey("dev-vm", "wdev"), "repo"],
      [browserKey("tpage"), "Docs"],
    ],
    true,
  ),
  row("gbbbbbbbbbb", termKey("build", "wbuild"), [
    [termKey("build", "wbuild"), "ci"],
  ]),
  row("gcccccccccc", undefined, []),
  row("gdddddddddd", termKey("dev-vm", "wdev2"), [
    [termKey("dev-vm", "wdev2"), "x"],
  ]),
];

const machines: Machine[] = [
  { target: "dev-vm", name: "dev", allowPaneTo: ["build"] },
  { target: "build" },
];

function setup(
  opts: {
    granted?: boolean;
    askEach?: boolean;
    down?: string[];
    close?: "closed" | "running";
    rows?: Row[];
  } = {},
) {
  const calls: unknown[][] = [];
  const table = createWorkspaceCommands({
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
    gws: () => state,
    rows: () => opts.rows ?? rowsOn(termKey(LOCAL, "wlocal")),
    browser: true,
    granted: () => opts.granted === true,
    anyAskEach: () => opts.askEach === true,
    workspaces: {
      closeWorkspaceNow: async (gid, force) => {
        calls.push(["close", gid, force]);
        return opts.close ?? "closed";
      },
      moveWorkspace: (gid, dir) => {
        calls.push(["move", gid, dir]);
        return dir === "down";
      },
      renameWorkspace: (gid, name) => {
        calls.push(["rename", gid, name]);
        return name === "gaaaaaaaaaa" ? "bad name" : undefined;
      },
      createEmptyWorkspace: (name) => {
        calls.push(["new", name]);
        return name === "x".repeat(200)
          ? { error: "too long" }
          : { id: "gnew0000000" };
      },
      showGws: (gid) => calls.push(["showGws", gid]),
      goRow: (r) => calls.push(["goRow", r.gws]),
    },
    tabs: {
      activateTab: (gid, ref) => calls.push(["show", gid, ref.kind]),
    },
  });
  const run = (
    command: string,
    args: Record<string, unknown>,
    from = LOCAL,
    tab = "",
  ) =>
    table[command].run(args, {
      from,
      pane: "t1",
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

const ids = (r: unknown) =>
  (r as { workspaces: { id: string }[] }).workspaces.map((w) => w.id);

describe("kisui workspace の受け持ち", () => {
  it("どれもリモートの Machine の Pane の頼みを受ける印（remote）が付いている", () => {
    const { table } = setup();
    assert.deepEqual(Object.keys(table).sort(), [
      "workspace.close",
      "workspace.list",
      "workspace.move",
      "workspace.new",
      "workspace.rename",
      "workspace.show",
    ]);
    for (const c of Object.values(table)) assert.equal(c.remote, true);
  });
});

describe("kisui workspace list", () => {
  it("手元の PC の Pane からは、Tab の無い Workspace も含め、全部を並びの順に出す", async () => {
    const { run } = setup();
    assert.deepEqual(await run("workspace.list", {}, LOCAL, "wlocal"), {
      workspaces: [
        { id: "gaaaaaaaaaa", name: "ws1", tabs: 3, current: true, self: true },
        { id: "gbbbbbbbbbb", name: "review", tabs: 1 },
        { id: "gcccccccccc", name: "empty", tabs: 0 },
        { id: "gdddddddddd", name: "devonly", tabs: 1 },
      ],
    });
  });

  it("リモートの Machine の Pane からは、届く Tab を持つ Workspace と空の Workspace だけを、届く Tab だけ数えて出す", async () => {
    const { run } = setup();
    assert.deepEqual(await run("workspace.list", {}, "dev-vm", "wdev"), {
      workspaces: [
        // 手元の PC の Terminal tab と Browser tab には届かない
        { id: "gaaaaaaaaaa", name: "ws1", tabs: 1, current: true, self: true },
        // build は dev の allow_pane_to にある
        { id: "gbbbbbbbbbb", name: "review", tabs: 1 },
        { id: "gcccccccccc", name: "empty", tabs: 0 },
        { id: "gdddddddddd", name: "devonly", tabs: 1 },
      ],
    });
    assert.deepEqual(ids(await run("workspace.list", {}, "build")), [
      "gbbbbbbbbbb",
      "gcccccccccc",
    ]);
  });

  it("手元の PC の操作を許している間は、手元の PC の Tab も数える", async () => {
    const { run } = setup({ granted: true });
    const r = (await run("workspace.list", {}, "dev-vm")) as {
      workspaces: { tabs: number }[];
    };
    assert.equal(r.workspaces[0].tabs, 3);
  });
});

describe("kisui workspace new", () => {
  it("Tab の無い Workspace を作り、id を返す", async () => {
    const { run, calls } = setup();
    assert.deepEqual(await run("workspace.new", { name: "api" }, "dev-vm"), {
      id: "gnew0000000",
    });
    assert.deepEqual(calls, [["new", "api"]]);
  });

  it("名前の決まりに合わなければ断る。name が文字でなければ断る", async () => {
    const { run } = setup();
    assert.equal(
      (await refusal(() => run("workspace.new", { name: "x".repeat(200) })))
        .message,
      "too long",
    );
    await refusal(() => run("workspace.new", {}));
  });
});

describe("kisui workspace rename", () => {
  it("名前か id で指して、名前を変える（空の名前も渡す）", async () => {
    const { run, calls } = setup();
    await run("workspace.rename", { workspace: "review", name: "pr" });
    await run("workspace.rename", { workspace: "gbbbbbbbbbb", name: "" });
    assert.deepEqual(calls, [
      ["rename", "gbbbbbbbbbb", "pr"],
      ["rename", "gbbbbbbbbbb", ""],
    ]);
  });

  it("Workspace の名前の決まりに合わない名前は、Window の断りの文で断る", async () => {
    const { run } = setup();
    assert.equal(
      (
        await refusal(() =>
          run("workspace.rename", { workspace: "review", name: "gaaaaaaaaaa" }),
        )
      ).message,
      "bad name",
    );
  });

  it("無い Workspace・同じ名前が 2 つの Workspace は断る", async () => {
    const { run } = setup();
    await refusal(() =>
      run("workspace.rename", { workspace: "nope", name: "a" }),
    );
    const dup: GwsState = {
      list: [
        { id: "g1", name: "a", num: 1, tabs: [] },
        { id: "g2", name: "a", num: 2, tabs: [] },
      ],
    };
    const t = createWorkspaceCommands({
      sessions: {
        states: () => ({}) as never,
        machines: () => machines,
        labelOf: (x) => x,
      },
      gws: () => dup,
      rows: () => [],
      browser: true,
      granted: () => false,
      anyAskEach: () => false,
      workspaces: {} as never,
      tabs: {} as never,
    });
    const e = await refusal(() =>
      t["workspace.rename"].run(
        { workspace: "a", name: "b" },
        {
          from: LOCAL,
          pane: "t",
          tab: "",
          signal: new AbortController().signal,
        },
      ),
    );
    assert.match(e.message, /g1, g2/);
  });

  it("リモートの Machine の Pane からは、届かない Workspace を、無いときと同じ文で断る", async () => {
    const { run, calls } = setup();
    // review は build の Tab で、dev の allow_pane_to にあるので届く
    await run("workspace.rename", { workspace: "review", name: "x" }, "dev-vm");
    const miss = await refusal(() =>
      run("workspace.rename", { workspace: "devonly", name: "x" }, "build"),
    );
    const none = await refusal(() =>
      run("workspace.rename", { workspace: "nope", name: "x" }, "build"),
    );
    assert.equal(miss.message.replace("devonly", "nope"), none.message);
    assert.equal(calls.length, 1);
  });
});

describe("kisui workspace close", () => {
  it("--force を渡して閉じる。空の Workspace も閉じる", async () => {
    const { run, calls } = setup();
    await run("workspace.close", { workspace: "empty" });
    await run("workspace.close", { workspace: "review", force: true });
    assert.deepEqual(calls, [
      ["close", "gcccccccccc", false],
      ["close", "gbbbbbbbbbb", true],
    ]);
  });

  it("プログラムが動いていれば、busy の印を付けて断る", async () => {
    const { run } = setup({ close: "running" });
    const e = await refusal(() =>
      run("workspace.close", { workspace: "review" }),
    );
    assert.equal(e.code, "busy");
  });

  it("リモートの Machine の Pane は、届かない Tab がある Workspace を閉じられない", async () => {
    const { run, calls } = setup();
    // ws1 には手元の PC の Tab があり、dev からは届かない
    await refusal(() => run("workspace.close", { workspace: "ws1" }, "dev-vm"));
    await run("workspace.close", { workspace: "devonly" }, "dev-vm");
    assert.deepEqual(calls, [["close", "gdddddddddd", false]]);
  });

  it("手元の PC の操作を許していても、聞く Pane があるうちは、手元の PC の Terminal tab を含む Workspace を閉じられない", async () => {
    const { run, calls } = setup({ granted: true, askEach: true });
    await refusal(() => run("workspace.close", { workspace: "ws1" }, "dev-vm"));
    await run("workspace.close", { workspace: "ws1" }, LOCAL);
    assert.deepEqual(calls, [["close", "gaaaaaaaaaa", false]]);
  });
});

describe("kisui workspace close（今いる Workspace）", () => {
  // 今いるのは、Tab の無い empty
  const onEmpty = (): Row[] =>
    rowsOn(termKey(LOCAL, "wlocal")).map((r) => ({
      ...r,
      band: { focused: r.gws === "gcccccccccc" },
      tabs: { ...r.tabs, focused: false },
    })) as Row[];

  it("許していないリモートの Machine は、キーがその Machine の Terminal tab に向いていなければ、今いる Workspace を閉じられない", async () => {
    const { run, calls } = setup({ rows: onEmpty() });
    await refusal(() =>
      run("workspace.close", { workspace: "empty" }, "dev-vm"),
    );
    assert.deepEqual(calls, []);
  });

  it("今いない Workspace は閉じられる。許している間・手元の PC の Pane からは、今いる Workspace も閉じられる", async () => {
    const a = setup();
    await a.run("workspace.close", { workspace: "empty" }, "dev-vm");
    const b = setup({ rows: onEmpty(), granted: true });
    await b.run("workspace.close", { workspace: "empty" }, "dev-vm");
    const c = setup({ rows: onEmpty() });
    await c.run("workspace.close", { workspace: "empty" }, LOCAL);
    assert.equal(a.calls.length + b.calls.length + c.calls.length, 3);
  });

  it("キーがその Machine の Terminal tab に向いていれば、今いる Workspace を閉じられる", async () => {
    const rows = rowsOn(termKey("dev-vm", "wdev"));
    rows[0] = { ...rows[0], band: { focused: false } } as Row;
    rows[3] = {
      ...rows[3],
      band: { focused: true },
      tabs: {
        ...rows[3].tabs,
        focused: true,
        shown: termKey("dev-vm", "wdev2"),
      },
    } as Row;
    const { run, calls } = setup({ rows });
    await run("workspace.close", { workspace: "devonly" }, "dev-vm");
    assert.deepEqual(calls, [["close", "gdddddddddd", false]]);
  });
});

describe("kisui workspace move", () => {
  it("上下に動かし、動いたかを返す", async () => {
    const { run, calls } = setup();
    assert.deepEqual(
      await run("workspace.move", { workspace: "review", dir: "down" }),
      { id: "gbbbbbbbbbb", moved: true },
    );
    assert.deepEqual(
      await run("workspace.move", { workspace: "review", dir: "up" }),
      { id: "gbbbbbbbbbb", moved: false },
    );
    assert.equal(calls.length, 2);
    await refusal(() =>
      run("workspace.move", { workspace: "review", dir: "left" }),
    );
  });
});

describe("kisui workspace show", () => {
  it("手元の PC の Pane からは、その Workspace が表示している Tab を表示する", async () => {
    const { run, calls } = setup();
    await run("workspace.show", { workspace: "review" });
    assert.deepEqual(calls, [["show", "gbbbbbbbbbb", "term"]]);
  });

  it("Tab の無い Workspace は、その行へ移る", async () => {
    const { run, calls } = setup();
    await run("workspace.show", { workspace: "empty" });
    assert.deepEqual(calls, [["goRow", "gcccccccccc"]]);
  });

  it("つながっていない Machine の Terminal tab を表示している Workspace は断る", async () => {
    const { run, calls } = setup({ down: ["build"] });
    await refusal(() => run("workspace.show", { workspace: "review" }));
    assert.deepEqual(calls, []);
  });

  it("リモートの Machine の Pane は、キーがその Machine の Terminal tab に向いていて、行き先もその Machine の Terminal tab のときだけ通る", async () => {
    // キーは手元の PC の Terminal tab：断る
    const a = setup();
    await refusal(() =>
      a.run("workspace.show", { workspace: "devonly" }, "dev-vm"),
    );
    // キーは dev の Terminal tab、行き先も dev の Terminal tab
    const b = setup({ rows: rowsOn(termKey("dev-vm", "wdev")) });
    await b.run("workspace.show", { workspace: "devonly" }, "dev-vm");
    assert.deepEqual(b.calls, [["show", "gdddddddddd", "term"]]);
    // 行き先が、ほかの Machine の Terminal tab：断る
    await refusal(() =>
      b.run("workspace.show", { workspace: "review" }, "dev-vm"),
    );
    // 行き先が、Tab の無い画面：断る
    await refusal(() =>
      b.run("workspace.show", { workspace: "empty" }, "dev-vm"),
    );
    assert.equal(b.calls.length, 1);
  });

  it("手元の PC の操作を許している間は、リモートの Machine の Pane も、どの Workspace も表示できる", async () => {
    const { run, calls } = setup({ granted: true });
    await run("workspace.show", { workspace: "empty" }, "dev-vm");
    assert.deepEqual(calls, [["goRow", "gcccccccccc"]]);
  });
});
