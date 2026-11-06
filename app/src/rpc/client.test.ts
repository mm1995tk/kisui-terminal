// プロトコルのクライアントのテスト。Node 組み込みのテストランナーで回す（npm test）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client, type Transport } from "./client.ts";
import {
  ConnectionClosedError,
  ErrorCode,
  MARKER,
  RpcError,
  parseMessage,
} from "./message.ts";
import { hasCapability } from "./protocol.ts";

class FakeTransport implements Transport {
  sent: Record<string, unknown>[] = [];
  closed = false;
  write(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
}

function setup(opts: { waitForMarker?: boolean } = { waitForMarker: false }) {
  const t = new FakeTransport();
  const discards: string[] = [];
  const c = new Client(t, { ...opts, onDiscard: (r) => discards.push(r) });
  return { t, c, discards };
}

const line = (o: unknown) => JSON.stringify(o) + "\n";

describe("要求と応答の対応", () => {
  it("id で対応づけ、順番が前後しても取り違えない", async () => {
    const { t, c } = setup();
    const a = c.request("server.info", {});
    const b = c.request("workspace.list", {});
    assert.equal(t.sent.length, 2);
    assert.equal(t.sent[0].jsonrpc, "2.0");
    assert.equal(t.sent[0].method, "server.info");
    assert.equal(t.sent[1].method, "workspace.list");
    assert.notEqual(t.sent[0].id, t.sent[1].id);

    // b の返事が先に来る
    c.feed(
      line({
        jsonrpc: "2.0",
        id: t.sent[1].id,
        result: { workspaces: [], focus: null },
      }),
    );
    c.feed(line({ jsonrpc: "2.0", id: t.sent[0].id, result: { pid: 7 } }));
    assert.deepEqual(await b, { workspaces: [], focus: null });
    assert.deepEqual(await a, { pid: 7 });
  });

  it("エラー応答は RpcError で失敗する", async () => {
    const { t, c } = setup();
    const p = c.request("term.close", { termId: "t1" });
    c.feed(
      line({
        jsonrpc: "2.0",
        id: t.sent[0].id,
        error: { code: -32003, message: "no such terminal" },
      }),
    );
    await assert.rejects(p, (e: unknown) => {
      assert.ok(e instanceof RpcError);
      assert.equal(e.code, ErrorCode.NotFound);
      assert.equal(e.codeName, "not_found");
      return true;
    });
  });

  it("待っていない id の応答は捨てる", async () => {
    const { c, discards } = setup();
    c.feed(line({ jsonrpc: "2.0", id: 999, result: {} }));
    c.feed(
      line({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      }),
    );
    assert.equal(discards.length, 2);
  });

  it("接続が閉じたら待っていた要求は ConnectionClosedError で失敗し、以後の要求も失敗する", async () => {
    const { c, t } = setup();
    const p = c.request("session.ping", {});
    let closedWith: string | undefined;
    c.onClose((r) => (closedWith = r));
    c.close("eof");
    await assert.rejects(p, ConnectionClosedError);
    await assert.rejects(c.request("session.ping", {}), ConnectionClosedError);
    assert.equal(closedWith, "eof");
    assert.equal(t.closed, true);
  });

  it("要求の形は JSON-RPC 2.0", () => {
    const { c, t } = setup();
    void c.request("tree.watch", { workspaceId: "w1", paths: ["", "src"] });
    assert.deepEqual(t.sent[0], {
      jsonrpc: "2.0",
      id: t.sent[0].id,
      method: "tree.watch",
      params: { workspaceId: "w1", paths: ["", "src"] },
    });
  });
});

describe("通知", () => {
  it("通知を種類ごとに受け取り、外すと届かない", () => {
    const { c } = setup();
    const got: unknown[] = [];
    const off = c.on("pane.hide", (p) => got.push(p));
    c.feed(
      line({
        jsonrpc: "2.0",
        method: "pane.hide",
        params: { workspaceId: "hi" },
      }),
    );
    off();
    c.feed(
      line({
        jsonrpc: "2.0",
        method: "pane.hide",
        params: { workspaceId: "later" },
      }),
    );
    assert.deepEqual(got, [{ workspaceId: "hi" }]);
  });

  it("知らない通知は無視する（onAny には見える）", () => {
    const { c, discards } = setup();
    const seen: string[] = [];
    c.onAny((m) => seen.push(m));
    c.feed(line({ jsonrpc: "2.0", method: "future.thing", params: { x: 1 } }));
    assert.deepEqual(seen, ["future.thing"]);
    assert.deepEqual(discards, []);
  });

  it("受け取る側が例外を投げても、続きの通知を処理する", () => {
    const { c, discards } = setup();
    const got: string[] = [];
    c.on("pane.hide", () => {
      throw new Error("boom");
    });
    c.on("notify", (p) => got.push(p.text));
    c.feed(
      line({
        jsonrpc: "2.0",
        method: "pane.hide",
        params: { workspaceId: "w1" },
      }),
    );
    c.feed(
      line({
        jsonrpc: "2.0",
        method: "notify",
        params: { level: "info", text: "ok" },
      }),
    );
    assert.deepEqual(got, ["ok"]);
    assert.equal(discards.length, 1);
  });

  it("kisui-terminal からの通知は id を付けずに送る", () => {
    const { c, t } = setup();
    c.notify("term.ack", { termId: "t1", seq: 5 });
    assert.deepEqual(t.sent[0], {
      jsonrpc: "2.0",
      method: "term.ack",
      params: { termId: "t1", seq: 5 },
    });
  });

  it("shj からの要求には method_not_found を返す", () => {
    const { c, t } = setup();
    c.feed(line({ jsonrpc: "2.0", id: 1, method: "future.ask", params: {} }));
    assert.equal(t.sent[0].id, 1);
    assert.equal(
      (t.sent[0].error as { code: number }).code,
      ErrorCode.MethodNotFound,
    );
  });
});

describe("1 行 1 メッセージ", () => {
  it("途中で切れた入力をためて、改行でつなぐ", () => {
    const { c } = setup();
    const got: string[] = [];
    c.on("notify", (p) => got.push(p.text));
    const l = line({
      jsonrpc: "2.0",
      method: "notify",
      params: { level: "info", text: "日本語\nの中の改行" },
    });
    const bytes = l.length;
    c.feed(l.slice(0, 10));
    c.feed(l.slice(10, bytes - 1));
    assert.deepEqual(got, []);
    c.feed("\n");
    assert.deepEqual(got, ["日本語\nの中の改行"]);
  });

  it("1 回に複数行来ても、CRLF でも、空行があっても読む", () => {
    const { c } = setup();
    const got: string[] = [];
    c.on("notify", (p) => got.push(p.text));
    const m = (text: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notify",
        params: { level: "i", text },
      });
    c.feed(`${m("a")}\r\n\n${m("b")}\n${m("c")}`);
    assert.deepEqual(got, ["a", "b"]);
  });

  it("読めない行は捨てて、続きを読む", () => {
    const { c, discards } = setup();
    const got: string[] = [];
    c.on("notify", (p) => got.push(p.text));
    c.feed("not json\n");
    c.feed(line({ jsonrpc: "1.0", method: "notify" }));
    c.feed(
      line({
        jsonrpc: "2.0",
        method: "notify",
        params: { level: "i", text: "ok" },
      }),
    );
    assert.deepEqual(got, ["ok"]);
    assert.equal(discards.length, 2);
  });
});

describe("始まりの目印", () => {
  it("目印より前の行は、JSON に見えるものも含めて捨てる", async () => {
    const { c, t } = setup({ waitForMarker: true });
    const got: string[] = [];
    c.on("notify", (p) => got.push(p.text));
    assert.equal(c.isReady, false);

    c.feed("Welcome to host (motd)\n");
    c.feed(
      line({
        jsonrpc: "2.0",
        method: "notify",
        params: { level: "i", text: "before" },
      }),
    );
    assert.deepEqual(got, []);
    assert.equal(c.isReady, false);

    c.feed(MARKER + "\n");
    assert.equal(c.isReady, true);
    c.feed(
      line({
        jsonrpc: "2.0",
        method: "notify",
        params: { level: "i", text: "after" },
      }),
    );
    assert.deepEqual(got, ["after"]);

    const p = c.request("session.ping", {});
    c.feed(line({ jsonrpc: "2.0", id: t.sent[0].id, result: {} }));
    await p;
  });

  it("目印が途中で切れて届いても、CRLF でも見つける", () => {
    const { c } = setup({ waitForMarker: true });
    c.feed("motd\r\n@@shj-");
    assert.equal(c.isReady, false);
    c.feed("rpc 1@@\r\n");
    assert.equal(c.isReady, true);
  });

  it("目印と同じ塊に続きが付いていても、続きは読む", () => {
    const { c } = setup({ waitForMarker: true });
    const got: string[] = [];
    c.on("notify", (p) => got.push(p.text));
    c.feed(
      `junk\n${MARKER}\n` +
        line({
          jsonrpc: "2.0",
          method: "notify",
          params: { level: "i", text: "x" },
        }),
    );
    assert.deepEqual(got, ["x"]);
  });

  it("目印が来ないまま閉じたら、要求は失敗する", async () => {
    const { c } = setup({ waitForMarker: true });
    const p = c.request("session.hello", {
      protocol: { major: 4, minor: 0 },
      client: { name: "t", version: "0", kind: "web" },
      encoding: ["json"],
    });
    c.close("eof before marker");
    await assert.rejects(p, ConnectionClosedError);
  });
});

describe("メッセージの読み取り", () => {
  it("id が null の要求は通知として読む", () => {
    const m = parseMessage('{"jsonrpc":"2.0","id":null,"method":"x"}');
    assert.equal("id" in m, false);
  });

  it("形が標準に合わないものは断る", () => {
    assert.throws(() => parseMessage("[]"));
    assert.throws(() => parseMessage('{"jsonrpc":"2.0"}'));
    assert.throws(() => parseMessage('{"jsonrpc":"2.0","id":{},"method":"x"}'));
    assert.throws(() =>
      parseMessage('{"jsonrpc":"2.0","id":1,"error":{"code":"x"}}'),
    );
  });
});

describe("capabilities", () => {
  it("あるものだけ true", () => {
    const hello = { capabilities: ["term", "tree"] };
    assert.equal(hasCapability(hello, "tree"), true);
    assert.equal(hasCapability(hello, "msgpack"), false);
  });
});
