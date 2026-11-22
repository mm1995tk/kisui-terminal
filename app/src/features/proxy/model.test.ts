import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProxyFlow } from "../../infrastructure/rpc/protocol.ts";
import {
  applyFlow,
  browserScope,
  flowUrl,
  formatDuration,
  formatSize,
  scopeKey,
  statusKind,
  statusText,
  stepSelection,
  wsScope,
} from "./model.ts";

const flow = (id: number, over: Partial<ProxyFlow> = {}): ProxyFlow => ({
  id,
  time: 0,
  method: "GET",
  scheme: "https",
  host: "example.com",
  path: `/${id}`,
  status: 200,
  state: "done",
  reqSize: 0,
  respSize: 10,
  durationMs: 5,
  ...over,
});

describe("プロキシの通信の一覧", () => {
  it("届いた通信を、id の順に足す・同じ id は置き換える", () => {
    let list = applyFlow([], flow(1, { state: "pending", status: 0 }));
    list = applyFlow(list, flow(3));
    list = applyFlow(list, flow(2));
    assert.deepEqual(
      list.map((f) => f.id),
      [1, 2, 3],
    );
    list = applyFlow(list, flow(1, { status: 404 }));
    assert.deepEqual(
      list.map((f) => [f.id, f.status]),
      [
        [1, 404],
        [2, 200],
        [3, 200],
      ],
    );
  });

  it("上限を超えたら、古いものから捨てる", () => {
    let list: ProxyFlow[] = [];
    for (let i = 1; i <= 5; i++) list = applyFlow(list, flow(i), 3);
    assert.deepEqual(
      list.map((f) => f.id),
      [3, 4, 5],
    );
  });

  it("選ぶ通信を動かす（端では止まる。選んでいなければ、次はいちばん新しいもの）", () => {
    const list = [flow(4), flow(5), flow(7)];
    assert.equal(stepSelection(list, undefined, "next"), 7);
    assert.equal(stepSelection(list, undefined, "prev"), 4);
    assert.equal(stepSelection(list, 5, "next"), 7);
    assert.equal(stepSelection(list, 7, "next"), 7);
    assert.equal(stepSelection(list, 5, "prev"), 4);
    assert.equal(stepSelection(list, 4, "prev"), 4);
    assert.equal(stepSelection(list, 5, "first"), 4);
    assert.equal(stepSelection(list, 5, "last"), 7);
    // 選んでいた通信が捨てられていたら、選んでいないのと同じ
    assert.equal(stepSelection(list, 1, "next"), 7);
    assert.equal(stepSelection([], 1, "next"), undefined);
  });

  it("1 行に出す字", () => {
    assert.equal(
      flowUrl(flow(1, { path: "/a?b=1" })),
      "https://example.com/a?b=1",
    );
    assert.equal(formatSize(999), "999 B");
    assert.equal(formatSize(1536), "1.5 kB");
    assert.equal(formatSize(2_000_000), "2.0 MB");
    assert.equal(formatDuration(42), "42 ms");
    assert.equal(formatDuration(1234), "1.2 s");
    assert.equal(statusText(flow(1)), "200");
    assert.equal(statusText(flow(1, { status: 0, state: "pending" })), "…");
    assert.equal(statusText(flow(1, { status: 0, state: "failed" })), "!");
    assert.equal(statusKind(flow(1, { status: 302 })), "ok");
    assert.equal(statusKind(flow(1, { status: 404 })), "warn");
    assert.equal(statusKind(flow(1, { status: 502 })), "error");
    assert.equal(
      statusKind(flow(1, { status: 200, state: "failed" })),
      "error",
    );
    assert.equal(
      statusKind(flow(1, { status: 0, state: "pending" })),
      "pending",
    );
  });

  it("scope の名前は、kisui serve との取り決めの形", () => {
    assert.equal(wsScope("w3"), "ws:w3");
    assert.equal(browserScope("tabc"), "browser:tabc");
    assert.notEqual(scopeKey("@local", "ws:w1"), scopeKey("host", "ws:w1"));
  });
});
