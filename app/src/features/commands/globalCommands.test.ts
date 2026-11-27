import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WindowRunReport } from "../../infrastructure/rpc/protocol.ts";

import { LOCAL } from "../sessions/shell.ts";
import type { Command } from "./commands.ts";
import { createGlobalCommands } from "./globalCommands.ts";
import { createWindowRun, type WindowCaller } from "./windowRun.ts";

/** 答えの、断りの理由（行えたなら undefined）。 */
const errorOf = (r: WindowRunReport) => ("error" in r ? r.error : undefined);

const caller: WindowCaller = {
  from: LOCAL,
  pane: "t1",
  tab: "w1",
  signal: new AbortController().signal,
};

function setup(
  opts: {
    update?: boolean;
    download?: boolean;
    /** 開く・フォルダを出すのに失敗する */
    useFails?: boolean;
    notified?: boolean;
    fail?: boolean;
  } = {},
) {
  const ran: Command[] = [];
  const calls: unknown[][] = [];
  const failure = opts.fail ? { title: "Cannot", error: "broken" } : undefined;
  const table = createGlobalCommands({
    runCommand: (c) => ran.push(c),
    updates: { info: () => (opts.update ? ({} as never) : null) },
    downloads: {
      lastDownload: () =>
        opts.download
          ? { id: 7, name: "report.pdf", dir: "/d", ok: true }
          : undefined,
      useDownload: async (d, how) => {
        calls.push([how, d.name]);
        return !opts.useFails;
      },
    },
    mascot: {
      choose: async (name) => {
        calls.push(["choose", name]);
        return failure;
      },
      reloadCurrent: async () => {
        calls.push(["reload"]);
        return failure;
      },
      list: async () => ({
        root: "/home/u/.config/kisui-terminal/mascot",
        current: "cat",
        entries: [
          { name: "cat", error: null },
          { name: "dog", error: "no mascot.toml" },
        ],
      }),
    },
    focusLastNotified: () => {
      calls.push(["focusNotified"]);
      return opts.notified === true;
    },
  });
  const run = async (name: string, args: Record<string, unknown> = {}) =>
    table[name]!.run(args, caller);
  return { table, ran, calls, run };
}

describe("Window 全体の Command の CLI（#517）", () => {
  it("sidebar.toggle・scale・notice.dismiss は、キー操作と同じ Command を動かす", async () => {
    const { ran, run } = setup();
    await run("sidebar.toggle");
    await run("scale", { action: "in" });
    await run("scale", { action: "reset" });
    await run("notice.dismiss");
    assert.deepEqual(ran, [
      { id: "sidebar.toggle" },
      { id: "scale", arg: "in" },
      { id: "scale", arg: "reset" },
      { id: "notice.dismiss" },
    ]);
  });

  it("scale は、in・out・reset のほかを断る", async () => {
    const { ran, run } = setup();
    await assert.rejects(run("scale", { action: "huge" }));
    await assert.rejects(run("scale", {}));
    assert.deepEqual(ran, []);
  });

  it("notice.update・notice.openDownload・notice.revealDownload は、相手が無ければ何もせずに断る", async () => {
    const none = setup();
    await assert.rejects(none.run("notice.update"));
    await assert.rejects(
      none.run("notice.openDownload", { name: "report.pdf" }),
    );
    await assert.rejects(none.run("notice.revealDownload"));
    assert.deepEqual(none.ran, []);
    assert.deepEqual(none.calls, []);
    const some = setup({ update: true, download: true });
    await some.run("notice.update");
    assert.deepEqual(
      some.ran.map((c) => c.id),
      ["notice.update"],
    );
  });

  it("notice.openDownload は、名前が最後のダウンロードと同じときだけ開き、開いた名前を返す", async () => {
    const s = setup({ download: true });
    await assert.rejects(
      s.run("notice.openDownload", { name: "evil.command" }),
      /report\.pdf/,
    );
    await assert.rejects(s.run("notice.openDownload", {}));
    assert.deepEqual(s.calls, []);
    assert.deepEqual(
      await s.run("notice.openDownload", { name: "report.pdf" }),
      { name: "report.pdf" },
    );
    assert.deepEqual(await s.run("notice.revealDownload"), {
      name: "report.pdf",
    });
    assert.deepEqual(s.calls, [
      ["open", "report.pdf"],
      ["reveal", "report.pdf"],
    ]);
  });

  it("notice.openDownload・notice.revealDownload は、開けなかったら失敗を返す", async () => {
    const s = setup({ download: true, useFails: true });
    await assert.rejects(s.run("notice.openDownload", { name: "report.pdf" }));
    await assert.rejects(s.run("notice.revealDownload"));
  });

  it("notice.focusNotified は、通知を出した Pane が無ければ断る", async () => {
    await assert.rejects(setup().run("notice.focusNotified"));
    await setup({ notified: true }).run("notice.focusNotified");
  });

  it("mascot.select は名前で選び（Dialog は開かない）、できなければ理由で断る。mascot.list は名前と理由だけを返す", async () => {
    const ok = setup();
    assert.deepEqual(await ok.run("mascot.select", { name: " cat " }), {
      name: "cat",
    });
    await ok.run("mascot.reload");
    assert.deepEqual(ok.calls, [["choose", "cat"], ["reload"]]);
    assert.deepEqual(ok.ran, []);
    await assert.rejects(ok.run("mascot.select", { name: " " }));
    await assert.rejects(ok.run("mascot.select", {}));
    assert.deepEqual(await ok.run("mascot.list"), {
      current: "cat",
      entries: [
        { name: "cat", error: null },
        { name: "dog", error: "no mascot.toml" },
      ],
    });
    const bad = setup({ fail: true });
    await assert.rejects(bad.run("mascot.select", { name: "cat" }), /broken/);
    await assert.rejects(bad.run("mascot.reload"), /broken/);
  });

  it("どれも、リモートの Machine の Pane の頼みは断る", async () => {
    const { table, ran, calls } = setup({
      update: true,
      download: true,
      notified: true,
    });
    const w = createWindowRun([table]);
    for (const name of Object.keys(table)) {
      const r = await w.run("dev-vm", {
        id: name,
        pane: "t1",
        tab: "w1",
        command: name,
        args: { action: "in", name: "cat" },
      });
      assert.ok(errorOf(r), `${name} を通した`);
    }
    assert.deepEqual(ran, []);
    assert.deepEqual(calls, []);
  });
});
