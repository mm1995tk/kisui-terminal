import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WindowCommandError,
  type WindowCaller,
} from "../commands/windowRun.ts";
import type { Machine } from "../sessions/machines.ts";
import { LOCAL } from "../sessions/shell.ts";
import {
  browserKey,
  dbKey,
  termKey,
  type GwsState,
} from "../workspaces/model.ts";
import type { Row } from "../workspaces/rows.ts";
import { createDbCommands } from "./dbCommands.ts";

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
        { kind: "db", id: "dbmain", target: LOCAL, connection: "main" },
      ],
    },
  ],
};

const row = (shown: string, focused: boolean): Row =>
  ({
    gws: "gaaaaaaaaaa",
    tabs: {
      shown,
      focused,
      items: [
        { key: termKey(LOCAL, "wlocal"), title: "repo" },
        { key: termKey("dev-vm", "wdev"), title: "repo" },
        { key: browserKey("tpage"), title: "Docs" },
        { key: dbKey("dbmain"), title: "main" },
      ],
    },
  }) as unknown as Row;

const machines: Machine[] = [{ target: "dev-vm", name: "dev" }];

function setup(
  opts: {
    granted?: boolean;
    askEach?: boolean;
    run?: "none" | "read" | "free";
    running?: boolean;
    keysOn?: string;
  } = {},
) {
  const calls: unknown[][] = [];
  const table = createDbCommands({
    sessions: { machines: () => machines, labelOf: (t) => t },
    gws: () => state,
    rows: () => [row(opts.keysOn ?? termKey(LOCAL, "wlocal"), true)],
    browser: true,
    granted: () => opts.granted === true,
    anyAskEach: () => opts.askEach === true,
    db: {
      openConnection: async (gid, target, name, variant) => {
        calls.push(["open", gid, target, name, variant]);
        return { kind: "db", id: "dbnew", target, connection: name };
      },
      reloadCatalog: async (id) => {
        calls.push(["catalog", id]);
      },
      reloadStructure: (id) => void calls.push(["structure", id]),
      stepPage: (id, step) => {
        calls.push(["page", id, step]);
        return null;
      },
      showView: (id, view) => {
        calls.push(["view", id, view]);
        return true;
      },
      stepResultTab: (id, step) => {
        calls.push(["result", id, step]);
        return true;
      },
      closeResult: (id) => {
        calls.push(["closeResult", id]);
        return true;
      },
      exportData: (id, format) => {
        calls.push(["export", id, format]);
        return {
          tab: id,
          rows: 1,
          truncated: false,
          truncatedCells: false,
          text: "a\n1\n",
        };
      },
      historyOf: async (id) => {
        calls.push(["history", id]);
        return [{ sql: "SELECT 1", at: "2026-01-01T00:00:00.000Z", ok: true }];
      },
      agentRunOf: async () => opts.run ?? "read",
      endNow: async (id) => {
        calls.push(["end", id]);
        return { who: "you" };
      },
      runOf: () => (opts.running ? { running: { queryId: "q" } } : {}) as never,
    },
  });
  const run = (
    command: string,
    args: Record<string, unknown>,
    from = LOCAL,
    tab = "wlocal",
  ) =>
    table[command].run(args, {
      from,
      pane: "t1",
      tab,
      signal: new AbortController().signal,
    } satisfies WindowCaller);
  return { table, calls, run };
}

const refused = (f: () => unknown, re?: RegExp) =>
  assert.rejects(
    async () => f(),
    (e) => e instanceof WindowCommandError && (re ? re.test(e.message) : true),
  );

describe("kisui db: what has no command", () => {
  it("has no elevate and no tree, and everything else is there", () => {
    const { table } = setup();
    assert.deepEqual(Object.keys(table).sort(), [
      "db.elevateEnd",
      "db.export",
      "db.history",
      "db.open",
      "db.page",
      "db.refresh",
      "db.result",
      "db.view",
    ]);
  });
});

describe("kisui db: from a pane of this computer", () => {
  it("does what the keys do on the tab (by id or by name)", async () => {
    const { calls, run } = setup();
    await run("db.refresh", { tab: "dbmain" });
    await run("db.page", { tab: "main", dir: "next" });
    await run("db.view", { tab: "main", view: "structure" });
    assert.deepEqual(await run("db.result", { tab: "main", to: "prev" }), {
      id: "dbmain",
      moved: true,
    });
    await run("db.result", { tab: "main", to: "close" });
    assert.deepEqual(await run("db.elevateEnd", { tab: "main" }), {
      id: "dbmain",
      ended: "you",
    });
    assert.deepEqual(calls, [
      ["catalog", "dbmain"],
      ["structure", "dbmain"],
      ["page", "dbmain", "next"],
      ["view", "dbmain", "structure"],
      ["result", "dbmain", -1],
      ["closeResult", "dbmain"],
      ["end", "dbmain"],
    ]);
  });

  it("refuses a tab that is not a database tab, and a missing one", async () => {
    const { run } = setup();
    await refused(
      () => run("db.refresh", { tab: "Docs" }),
      /not a database tab/,
    );
    await refused(() => run("db.refresh", { tab: "none" }), /No tab/);
  });

  it("exports and lists the history when the agent may run SQL", async () => {
    const { calls, run } = setup();
    const out = (await run("db.export", { tab: "main", format: "csv" })) as {
      text: string;
    };
    assert.equal(out.text, "a\n1\n");
    await run("db.history", { tab: "main" });
    assert.deepEqual(calls, [
      ["export", "dbmain", "csv"],
      ["history", "dbmain"],
    ]);
  });

  it("refuses export and history when the agent's run is none", async () => {
    const { calls, run } = setup({ run: "none" });
    await refused(
      () => run("db.export", { tab: "main", format: "csv" }),
      /RUN is none/,
    );
    await refused(() => run("db.history", { tab: "main" }), /RUN is none/);
    assert.deepEqual(calls, []);
  });

  it("refuses export while a statement runs, and a bad format", async () => {
    await refused(
      () =>
        setup({ running: true }).run("db.export", {
          tab: "main",
          format: "csv",
        }),
      /running/,
    );
    await refused(() =>
      setup().run("db.export", { tab: "main", format: "xml" }),
    );
  });

  it("opens a tab in the workspace of the pane", async () => {
    const { calls, run } = setup();
    const out = await run("db.open", { connection: "shop", variant: "prod" });
    assert.deepEqual(out, { id: "dbnew", workspace: "gaaaaaaaaaa" });
    assert.deepEqual(calls, [["open", "gaaaaaaaaaa", LOCAL, "shop", "prod"]]);
  });
});

describe("kisui db: from a pane of a remote machine", () => {
  it("does not reach the tab, and says there is no such tab", async () => {
    const { calls, run } = setup();
    await refused(
      () => run("db.refresh", { tab: "dbmain" }, "dev-vm", "wdev"),
      /No tab/,
    );
    await refused(
      () => run("db.open", { connection: "shop" }, "dev-vm", "wdev"),
      /allows/,
    );
    assert.deepEqual(calls, []);
  });

  it("reaches it while the person allows the machine", async () => {
    const { calls, run } = setup({ granted: true });
    await run("db.page", { tab: "dbmain", dir: "next" }, "dev-vm", "wdev");
    await run("db.export", { tab: "dbmain", format: "json" }, "dev-vm", "wdev");
    const open = await run("db.open", { connection: "shop" }, "dev-vm", "wdev");
    assert.deepEqual(open, { id: "dbnew", workspace: "gaaaaaaaaaa" });
    assert.equal(calls.length, 3);
  });

  it("does not return the result or the history while a pane asks each time", async () => {
    const { calls, run } = setup({ granted: true, askEach: true });
    await refused(
      () =>
        run("db.export", { tab: "dbmain", format: "csv" }, "dev-vm", "wdev"),
      /ask the person every time/,
    );
    await refused(() => run("db.history", { tab: "dbmain" }, "dev-vm", "wdev"));
    // what shows nothing to the pane still works, and ending an elevation only lowers a permission
    await run("db.page", { tab: "dbmain", dir: "prev" }, "dev-vm", "wdev");
    await run("db.elevateEnd", { tab: "dbmain" }, "dev-vm", "wdev");
    assert.deepEqual(calls, [
      ["page", "dbmain", "prev"],
      ["end", "dbmain"],
    ]);
  });
});
