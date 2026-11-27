import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createWindowRun,
  WindowCommandError,
  type WindowCaller,
} from "../commands/windowRun.ts";
import { createMachineCommands, type MachineOps } from "./machineCommands.ts";
import type { MachineRow } from "./machineList.ts";
import type { Machine } from "./machines.ts";
import { LOCAL } from "./shell.ts";
import type { TermDefaults } from "./termDefaults.ts";

const row = (target: string, over: Partial<MachineRow> = {}): MachineRow => ({
  target,
  label: target,
  health: "up",
  status: "Connected",
  title: "",
  terminalTabs: 1,
  removable: target !== LOCAL,
  fixed: false,
  hasSession: true,
  ...over,
});

/** 手元の PC・dev-vm（名前 dev）・build（config.toml にだけある。切れている）。 */
function setup() {
  const machines: Machine[] = [
    { target: "dev-vm", name: "dev" },
    { target: "build", fixed: true },
  ];
  const rows: MachineRow[] = [
    row(LOCAL, { label: "Local", terminalTabs: 2 }),
    row("dev-vm", { label: "dev" }),
    row("build", {
      fixed: true,
      health: "down",
      status: "Not connected",
      hasSession: false,
      retry: "again",
      terminalTabs: 0,
    }),
  ];
  const calls: unknown[][] = [];
  const term: Record<string, TermDefaults> = {
    [LOCAL]: { shell: "/bin/zsh" },
    "dev-vm": { startDir: "~/work" },
  };
  const ops: MachineOps = {
    machines: () => machines,
    async addNow(target, name) {
      calls.push(["add", target, name]);
      return target === "bad" ? { error: "no" } : { target };
    },
    async renameNow(target, name) {
      calls.push(["rename", target, name]);
      return undefined;
    },
    async removeNow(target) {
      calls.push(["remove", target]);
      return undefined;
    },
    async disconnect(target) {
      calls.push(["disconnect", target]);
    },
    retry(target) {
      calls.push(["retry", target]);
    },
    async readTermDefaults(target) {
      return term[target] ?? {};
    },
    async writeTermDefaults(target, startDir, shell) {
      calls.push(["terminal", target, startDir, shell]);
      term[target] = {
        ...(startDir ? { startDir } : {}),
        ...(shell ? { shell } : {}),
      };
      return undefined;
    },
  };
  const table = createMachineCommands({
    sessions: ops,
    machineList: () => rows,
  });
  const caller = (from = LOCAL): WindowCaller => ({
    from,
    pane: "p1",
    tab: "w1",
    signal: new AbortController().signal,
  });
  const run = async (name: string, args: Record<string, unknown>) =>
    table[name].run(args, caller());
  return { table, calls, run, caller };
}

describe("kisui machine", () => {
  it("only a pane of the computer of the window may ask", async () => {
    const { table } = setup();
    for (const [name, h] of Object.entries(table))
      assert.equal(h.remote, undefined, name);
    // p・P（許す）は CLI にしない
    assert.deepEqual(Object.keys(table).sort(), [
      "machine.add",
      "machine.disconnect",
      "machine.list",
      "machine.reconnect",
      "machine.remove",
      "machine.rename",
      "machine.terminal",
    ]);
    const { calls } = setup();
    const wr = createWindowRun([table]);
    const r = await wr.run("dev-vm", {
      id: "1",
      pane: "p",
      tab: "w",
      command: "machine.remove",
      args: { machine: "dev" },
    });
    assert.ok("error" in r);
    assert.deepEqual(calls, []);
  });

  it("lists the machines as the dialog does", async () => {
    const { run } = setup();
    assert.deepEqual(await run("machine.list", {}), {
      machines: [
        {
          name: "local",
          connected: true,
          status: "Connected",
          terminalTabs: 2,
        },
        {
          name: "dev",
          ssh: "dev-vm",
          connected: true,
          status: "Connected",
          terminalTabs: 1,
        },
        {
          name: "build",
          ssh: "build",
          connected: false,
          status: "Not connected",
          terminalTabs: 0,
          fixed: true,
        },
      ],
    });
  });

  it("points at a machine by its name or its ssh destination", async () => {
    const { run, calls } = setup();
    await run("machine.disconnect", { machine: "dev" });
    await run("machine.disconnect", { machine: "dev-vm" });
    assert.deepEqual(calls, [
      ["disconnect", "dev-vm"],
      ["disconnect", "dev-vm"],
    ]);
    await assert.rejects(
      run("machine.disconnect", { machine: "nope" }),
      WindowCommandError,
    );
  });

  it("refuses what the dialog refuses", async () => {
    const { run, calls } = setup();
    for (const [name, machine] of [
      ["machine.rename", "local"],
      ["machine.rename", "build"],
      ["machine.remove", "local"],
      ["machine.remove", "build"],
      ["machine.disconnect", "local"],
      ["machine.disconnect", "build"],
      ["machine.reconnect", "dev"],
    ])
      await assert.rejects(
        run(name, { machine, name: "x" }),
        WindowCommandError,
        `${name} ${machine}`,
      );
    await run("machine.reconnect", { machine: "build" });
    await run("machine.rename", { machine: "dev", name: "d2" });
    await run("machine.remove", { machine: "dev" });
    assert.deepEqual(calls, [
      ["retry", "build"],
      ["rename", "dev-vm", "d2"],
      ["remove", "dev-vm"],
    ]);
  });

  it("adds a machine and answers its name", async () => {
    const { run, calls } = setup();
    assert.deepEqual(await run("machine.add", { ssh: "dev-vm" }), {
      name: "dev",
    });
    await assert.rejects(run("machine.add", { ssh: "bad" }), /no/);
    assert.deepEqual(calls[0], ["add", "dev-vm", ""]);
  });

  it("prints and changes the terminal settings", async () => {
    const { run, calls } = setup();
    assert.deepEqual(await run("machine.terminal", { machine: "dev" }), {
      startDir: "~/work",
    });
    // config.toml にだけある Machine は、見られるが、変えられない
    assert.deepEqual(await run("machine.terminal", { machine: "build" }), {});
    await assert.rejects(
      run("machine.terminal", { machine: "build", shell: "/bin/sh" }),
      WindowCommandError,
    );
    // 付けなかった項目は今のまま
    assert.deepEqual(
      await run("machine.terminal", { machine: "dev", shell: "/usr/bin/fish" }),
      { startDir: "~/work", shell: "/usr/bin/fish" },
    );
    assert.deepEqual(
      await run("machine.terminal", { machine: "local", unsetShell: true }),
      {},
    );
    await assert.rejects(
      run("machine.terminal", {
        machine: "dev",
        shell: "/bin/sh",
        unsetShell: true,
      }),
      WindowCommandError,
    );
    assert.deepEqual(calls, [
      ["terminal", "dev-vm", "~/work", "/usr/bin/fish"],
      ["terminal", LOCAL, "", ""],
    ]);
  });
});
