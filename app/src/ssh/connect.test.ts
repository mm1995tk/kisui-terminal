import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AskpassRequest, ClosedEvent, ShellApi } from "./api.ts";
import { connectShj, ConnectError, ShjMissingError } from "./connect.ts";

type Handlers = {
  line: ((e: { id: string; line: string }) => void)[];
  closed: ((e: ClosedEvent) => void)[];
  askpass: ((e: AskpassRequest) => void)[];
};

function fakeApi(onConnect: (h: Handlers, id: string, target: string) => void) {
  const h: Handlers = { line: [], closed: [], askpass: [] };
  const sent: { id: string; text: string }[] = [];
  const connects: { id: string; target: string }[] = [];
  const disconnects: string[] = [];
  const reg = <T>(list: T[], f: T) => {
    list.push(f);
    return Promise.resolve(() => {
      list.splice(list.indexOf(f), 1);
    });
  };
  const api: ShellApi = {
    listSshHosts: async () => [],
    configMachines: async () => [],
    connect: async (id, target) => {
      connects.push({ id, target });
      onConnect(h, id, target);
    },
    send: async (id, text) => {
      sent.push({ id, text });
      const msg = JSON.parse(text);
      if (msg.method === "session.bye") {
        queueMicrotask(() =>
          h.line.forEach((f) =>
            f({
              id,
              line: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }),
            }),
          ),
        );
      }
      if (msg.method === "session.hello") {
        queueMicrotask(() =>
          h.line.forEach((f) =>
            f({
              id,
              line: JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  protocol: { major: 3, minor: 0 },
                  encoding: "json",
                  shj: { version: "1", commit: "x", channel: "stable" },
                  serverId: "s",
                  startedAt: "now",
                  capabilities: [],
                  workspaces: [],
                  rev: 0,
                },
              }),
            }),
          ),
        );
      }
    },
    disconnect: async (id) => {
      disconnects.push(id);
    },
    askpassReply: async () => {},
    onLine: (f) => reg(h.line, f),
    onClosed: (f) => reg(h.closed, f),
    onAskpass: (f) => reg(h.askpass, f),
    installPlan: async () => ({
      version: "0.0.0",
      path: "p",
      release_url: "u",
    }),
    installRemote: async () => ({ path: "p", asset: "a", sha256: "h" }),
    installCancel: async () => {},
    onAskpassDone: async () => () => {},
  };
  return { api, h, sent, connects, disconnects };
}

describe("connectShj", () => {
  it("目印より前（motd）を捨てて session.hello が通る", async () => {
    const f = fakeApi((h, id) => {
      for (const line of ["Welcome to host", "@@shj-rpc 1@@"])
        h.line.forEach((fn) => fn({ id, line }));
    });
    const c = await connectShj(f.api, "myhost", { id: "t1" });
    assert.equal(f.connects[0].target, "myhost");
    assert.equal(c.hello.serverId, "s");
    assert.equal(JSON.parse(f.sent[0].text).method, "session.hello");
    // 他の接続の行は無視する
    f.h.line.forEach((fn) => fn({ id: "other", line: "{garbage" }));
    await c.close();
    assert.ok(f.disconnects.includes("t1"));
    assert.equal(f.h.line.length, 0, "聞くのをやめている");
  });

  it("ssh が終わって失敗したら標準エラー付きの ConnectError", async () => {
    const f = fakeApi((h, id) => {
      queueMicrotask(() =>
        h.closed.forEach((fn) =>
          fn({ id, code: 255, stderr: "Permission denied (publickey)." }),
        ),
      );
    });
    await assert.rejects(
      connectShj(f.api, "badhost", { id: "t2" }),
      (e: unknown) =>
        e instanceof ConnectError && e.stderr.includes("Permission denied"),
    );
    assert.equal(f.h.line.length, 0);
    assert.equal(f.h.closed.length, 0);
  });

  it("ローカルも同じ流れ", async () => {
    const f = fakeApi((h, id) =>
      h.line.forEach((fn) => fn({ id, line: "@@shj-rpc 1@@" })),
    );
    const c = await connectShj(f.api, "@local", { id: "t3" });
    assert.equal(f.connects[0].target, "@local");
    await c.close();
  });

  it("リモートのシェルが 97 で終わったら ShjMissingError（ssh の 255 とは別）", async () => {
    const f = fakeApi((h, id) => {
      queueMicrotask(() =>
        h.closed.forEach((fn) => fn({ id, code: 97, stderr: "" })),
      );
    });
    await assert.rejects(
      connectShj(f.api, "nohost", { id: "t4" }),
      (e: unknown) => e instanceof ShjMissingError && e instanceof ConnectError,
    );
  });

  it("ローカルの 97 は ShjMissingError にしない（入れる先がない）", async () => {
    const f = fakeApi((h, id) => {
      queueMicrotask(() =>
        h.closed.forEach((fn) => fn({ id, code: 97, stderr: "" })),
      );
    });
    await assert.rejects(
      connectShj(f.api, "@local", { id: "t5" }),
      (e: unknown) =>
        e instanceof ConnectError && !(e instanceof ShjMissingError),
    );
  });
});
