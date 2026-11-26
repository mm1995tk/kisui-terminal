import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WindowCommandError,
  type WindowCaller,
} from "../../commands/windowRun.ts";
import type { Machine } from "../../sessions/machines.ts";
import { LOCAL } from "../../sessions/shell.ts";
import { browserKey, dbKey, termKey, type GwsState } from "../model.ts";
import type { Row } from "../rows.ts";
import { createTabCommands, findTabs, tabEntries } from "./tabCommands.ts";

// Workspace 2 つ：ws1 に手元の PC の Terminal tab・dev の Terminal tab・Browser tab、review に build の Terminal tab・Database tab
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
      tabs: [
        { kind: "term", target: "build", ws: "wbuild", title: "" },
        { kind: "db", id: "dbmain", target: "dev-vm", connection: "main" },
      ],
    },
  ],
};

/** Sidebar の行の、ここで使う分だけ。 */
const row = (gws: string, shown: string, items: [string, string][]): Row =>
  ({
    gws,
    tabs: { shown, items: items.map(([key, title]) => ({ key, title })) },
  }) as unknown as Row;

const rows: Row[] = [
  row("gaaaaaaaaaa", termKey(LOCAL, "wlocal"), [
    [termKey(LOCAL, "wlocal"), "repo"],
    [termKey("dev-vm", "wdev"), "repo"],
    [browserKey("tpage"), "Docs"],
  ]),
  row("gbbbbbbbbbb", dbKey("dbmain"), [
    [termKey("build", "wbuild"), "ci"],
    [dbKey("dbmain"), "main"],
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
  } = {},
) {
  const calls: unknown[][] = [];
  const table = createTabCommands({
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
    rows: () => rows,
    browser: true,
    granted: () => opts.granted === true,
    anyAskEach: () => opts.askEach === true,
    tabs: {
      activateTab: (gid, ref) => calls.push(["show", gid, ref.kind]),
      closeTabRow: (gid, key) => calls.push(["closeRow", gid, key]),
      closeTermTabNow: async (target, ws, force) => {
        calls.push(["closeTerm", target, ws, force]);
        return opts.close ?? "closed";
      },
      setTabName: async (gid, key, name) => {
        calls.push(["rename", gid, key, name]);
      },
      moveTabByStep: (gid, key, dir) => {
        calls.push(["step", gid, key, dir]);
        return dir === "down";
      },
      moveTabToWorkspace: (key, gid) => {
        calls.push(["moveTo", key, gid]);
        return true;
      },
    },
  });
  const caller = (from: string, tab = ""): WindowCaller => ({
    from,
    pane: "t1",
    tab,
    signal: new AbortController().signal,
  });
  const run = (
    command: string,
    args: Record<string, unknown>,
    from = LOCAL,
    tab = "",
  ) => table[command].run(args, caller(from, tab));
  return { calls, run };
}

/** 断りの文。断らなければ落ちる。 */
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
  (r as { tabs: { id: string }[] }).tabs.map((t) => t.id);

describe("kisui tab の、指せる Tab", () => {
  it("Sidebar の行から、id・名前・Machine を並びの順に作る（Browser tab と Database tab は手元の PC の Tab）", () => {
    assert.deepEqual(
      tabEntries(state, rows).map((e) => [e.id, e.name, e.target, e.shown]),
      [
        ["wlocal", "repo", LOCAL, true],
        ["wdev", "repo", "dev-vm", false],
        ["tpage", "Docs", LOCAL, false],
        ["wbuild", "ci", "build", false],
        ["dbmain", "main", LOCAL, true],
      ],
    );
  });

  it("id で探し、無ければ名前で探す。同じ名前が 2 つあれば、どちらも返す", () => {
    const list = tabEntries(state, rows);
    assert.deepEqual(
      findTabs(list, " wdev ").map((e) => e.id),
      ["wdev"],
    );
    assert.deepEqual(
      findTabs(list, "ci").map((e) => e.id),
      ["wbuild"],
    );
    assert.deepEqual(
      findTabs(list, "repo").map((e) => e.id),
      ["wlocal", "wdev"],
    );
    assert.deepEqual(findTabs(list, "nope"), []);
    assert.deepEqual(findTabs(list, ""), []);
  });
});

describe("kisui tab list", () => {
  it("手元の PC の Pane からは、どの Machine・どの Workspace の Tab も出る", async () => {
    const { run } = setup();
    const r = (await run("tab.list", {}, LOCAL, "wlocal")) as {
      tabs: Record<string, unknown>[];
    };
    assert.deepEqual(r.tabs, [
      {
        id: "wlocal",
        name: "repo",
        kind: "terminal",
        workspace: "gaaaaaaaaaa",
        workspaceName: "ws1",
        machine: "local",
        shown: true,
        self: true,
      },
      {
        id: "wdev",
        name: "repo",
        kind: "terminal",
        workspace: "gaaaaaaaaaa",
        workspaceName: "ws1",
        machine: "dev",
      },
      {
        id: "tpage",
        name: "Docs",
        kind: "browser",
        workspace: "gaaaaaaaaaa",
        workspaceName: "ws1",
        machine: "local",
      },
      {
        id: "wbuild",
        name: "ci",
        kind: "terminal",
        workspace: "gbbbbbbbbbb",
        workspaceName: "review",
        machine: "build",
      },
      {
        id: "dbmain",
        name: "main",
        kind: "database",
        workspace: "gbbbbbbbbbb",
        workspaceName: "review",
        machine: "local",
        shown: true,
      },
    ]);
  });

  it("--workspace は、名前か id で 1 つの Workspace に絞る。無ければ断る", async () => {
    const { run } = setup();
    assert.deepEqual(ids(await run("tab.list", { workspace: "review" })), [
      "wbuild",
      "dbmain",
    ]);
    assert.deepEqual(ids(await run("tab.list", { workspace: "gaaaaaaaaaa" })), [
      "wlocal",
      "wdev",
      "tpage",
    ]);
    await refusal(() => run("tab.list", { workspace: "nope" }));
  });

  it("リモートの Machine の Pane からは、その Machine の Tab と、allow_pane_to で許した Machine の Tab だけ", async () => {
    const { run } = setup();
    // dev は build を許している。手元の PC の Tab（Browser tab・Database tab も）は出ない
    assert.deepEqual(ids(await run("tab.list", {}, "dev-vm")), [
      "wdev",
      "wbuild",
    ]);
    // build は何も許していない
    assert.deepEqual(ids(await run("tab.list", {}, "build")), ["wbuild"]);
  });

  it("手元の PC の Tab は、Window の前の人が時間を決めて許している間だけ、リモートの Pane から届く", async () => {
    const { run } = setup({ granted: true });
    assert.deepEqual(ids(await run("tab.list", {}, "build")), [
      "wlocal",
      "tpage",
      "wbuild",
      "dbmain",
    ]);
  });
});

describe("kisui tab の操作", () => {
  it("rename：名前を確かめて、その Tab の名前を変える（空なら自動の名前に戻す）", async () => {
    const { run, calls } = setup();
    assert.deepEqual(await run("tab.rename", { tab: "ci", name: "build" }), {
      id: "wbuild",
    });
    await run("tab.rename", { tab: "tpage", name: "" });
    assert.deepEqual(calls, [
      ["rename", "gbbbbbbbbbb", termKey("build", "wbuild"), "build"],
      ["rename", "gaaaaaaaaaa", browserKey("tpage"), ""],
    ]);
    await refusal(() => run("tab.rename", { tab: "ci", name: "a\nb" }));
    await refusal(() => run("tab.rename", { tab: "ci" }));
    assert.equal(calls.length, 2);
  });

  it("rename・show：つながっていない Machine の Terminal tab は断る", async () => {
    const { run, calls } = setup({ down: ["build"] });
    await refusal(() => run("tab.rename", { tab: "ci", name: "x" }));
    await refusal(() => run("tab.show", { tab: "ci" }));
    assert.deepEqual(calls, []);
  });

  it("名前が 2 つ以上の Tab に当たるときは断り、id を並べる", async () => {
    const { run, calls } = setup();
    const e = await refusal(() => run("tab.show", { tab: "repo" }));
    assert.ok(e.message.includes("wlocal") && e.message.includes("wdev"));
    assert.deepEqual(calls, []);
    // id なら 1 つに決まる
    await run("tab.show", { tab: "wdev" });
    assert.deepEqual(calls, [["show", "gaaaaaaaaaa", "term"]]);
  });

  it("届かない Tab は、無い Tab と同じ文で断る（リモートの Machine に、あるかを教えない）", async () => {
    const { run, calls } = setup();
    const hidden = await refusal(() =>
      run("tab.close", { tab: "tpage" }, "dev-vm"),
    );
    const none = await refusal(() =>
      run("tab.close", { tab: "nope" }, "dev-vm"),
    );
    assert.equal(
      hidden.message.replace("tpage", "X"),
      none.message.replace("nope", "X"),
    );
    assert.ok(hidden.message.includes("allow_pane_to"));
    await refusal(() => run("tab.rename", { tab: "wdev", name: "x" }, "build"));
    assert.deepEqual(calls, []);
  });

  it("close：Browser tab と Database tab はそのまま閉じ、Terminal tab は Dialog を出さずに閉じる", async () => {
    const { run, calls } = setup();
    await run("tab.close", { tab: "Docs" });
    await run("tab.close", { tab: "dbmain" });
    await run("tab.close", { tab: "wbuild", force: true });
    assert.deepEqual(calls, [
      ["closeRow", "gaaaaaaaaaa", browserKey("tpage")],
      ["closeRow", "gbbbbbbbbbb", dbKey("dbmain")],
      ["closeTerm", "build", "wbuild", true],
    ]);
  });

  it("close：プログラムが動いている Terminal tab は、--force を案内して断る（code は busy）", async () => {
    const { run, calls } = setup({ close: "running" });
    const e = await refusal(() => run("tab.close", { tab: "ci" }));
    assert.equal(e.code, "busy");
    assert.ok(e.message.includes("--force"));
    assert.deepEqual(calls, [["closeTerm", "build", "wbuild", false]]);
  });

  it("close：「操作のたびに聞く」Pane があるうちは、リモートの Machine に手元の PC の Terminal tab を閉じさせない", async () => {
    const { run, calls } = setup({ granted: true, askEach: true });
    await refusal(() => run("tab.close", { tab: "wlocal" }, "build"));
    assert.deepEqual(calls, []);
    // 手元の PC の Pane からは閉じられる。リモートの Machine も、自分の Tab は閉じられる
    await run("tab.close", { tab: "wlocal" });
    await run("tab.close", { tab: "wbuild" }, "build");
    assert.equal(calls.length, 2);
  });

  it("move：Workspace の中で 1 つ動かす。端で動かなければ moved は false", async () => {
    const { run, calls } = setup();
    assert.deepEqual(await run("tab.move", { tab: "ci", dir: "down" }), {
      id: "wbuild",
      moved: true,
    });
    assert.deepEqual(await run("tab.move", { tab: "ci", dir: "up" }), {
      id: "wbuild",
      moved: false,
    });
    await refusal(() => run("tab.move", { tab: "ci", dir: "left" }));
    assert.equal(calls.length, 2);
  });

  it("moveTo：名前か id で指した Workspace へ移す。今の Workspace・無い Workspace は断る", async () => {
    const { run, calls } = setup();
    assert.deepEqual(await run("tab.moveTo", { tab: "ci", workspace: "ws1" }), {
      id: "wbuild",
      workspace: "gaaaaaaaaaa",
    });
    assert.deepEqual(calls, [
      ["moveTo", termKey("build", "wbuild"), "gaaaaaaaaaa"],
    ]);
    await refusal(() => run("tab.moveTo", { tab: "ci", workspace: "review" }));
    await refusal(() => run("tab.moveTo", { tab: "ci", workspace: "nope" }));
    assert.equal(calls.length, 1);
  });

  it("show：その Tab を表示する", async () => {
    const { run, calls } = setup();
    assert.deepEqual(await run("tab.show", { tab: "main" }), { id: "dbmain" });
    assert.deepEqual(calls, [["show", "gbbbbbbbbbb", "db"]]);
  });
});
