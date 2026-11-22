import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ProxyFlow,
  ProxyFlowDetail,
} from "../../infrastructure/rpc/protocol.ts";
import {
  applyFlow,
  browserScope,
  draftFrom,
  flowUrl,
  formatDuration,
  formatSize,
  parseHeaders,
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

describe("書き換えて送り直す（#410）", () => {
  const detail = (over: Partial<ProxyFlowDetail> = {}): ProxyFlowDetail => ({
    ...flow(3, {
      method: "POST",
      host: "api.example.com:8443",
      path: "/v1?x=1",
    }),
    protocol: "HTTP/1.1",
    reqHeaders: [
      ["Accept", "*/*"],
      ["Content-Length", "7"],
      ["Content-Type", "application/json"],
      ["Host", "api.example.com:8443"],
    ],
    respHeaders: [],
    reqBody: { size: 7, text: '{"a":1}' },
    respBody: { size: 0 },
    ...over,
  });

  it("draftFrom：URL とヘッダーと字の本文を下書きにする。URL と同じ Host と Content-Length は出さない", () => {
    assert.deepEqual(draftFrom(detail()), {
      from: 3,
      method: "POST",
      url: "https://api.example.com:8443/v1?x=1",
      headers: "Accept: */*\nContent-Type: application/json",
      body: { text: '{"a":1}', size: 7 },
    });
  });

  it("draftFrom：URL と違う Host は残す", () => {
    const d = draftFrom(detail({ reqHeaders: [["Host", "other.example"]] }));
    assert.equal(d.headers, "Host: other.example");
  });

  it("draftFrom：字でない・圧縮した本文は元のまま送り、切れた本文は書いたものを送る", () => {
    assert.deepEqual(
      draftFrom(detail({ reqBody: { size: 9, binary: true } })).body,
      { text: undefined, note: "binary", size: 9 },
    );
    assert.deepEqual(
      draftFrom(
        detail({
          reqHeaders: [["Content-Encoding", "gzip"]],
          reqBody: { size: 30, text: "decoded" },
        }),
      ).body,
      { text: undefined, note: "encoded", size: 30 },
    );
    assert.deepEqual(
      draftFrom(
        detail({ reqBody: { size: 300000, text: "abc", truncated: true } }),
      ).body,
      { text: "", note: "cut", size: 300000 },
    );
    assert.deepEqual(draftFrom(detail({ reqBody: { size: 0 } })).body, {
      text: "",
      size: 0,
    });
  });

  it("parseHeaders：1 行に 1 つ。空の行は飛ばし、値の中の : は残す", () => {
    assert.deepEqual(
      parseHeaders("Accept: */*\n\n  X-Url :  http://a:1/  \r\nEmpty:"),
      {
        headers: [
          ["Accept", "*/*"],
          ["X-Url", "http://a:1/"],
          ["Empty", ""],
        ],
      },
    );
  });

  it("parseHeaders：名前の無い・空白を含む行は、その行の番号", () => {
    assert.deepEqual(parseHeaders("Accept: */*\nno colon"), { badLine: 2 });
    assert.deepEqual(parseHeaders(": v"), { badLine: 1 });
    assert.deepEqual(parseHeaders("Bad Name: v"), { badLine: 1 });
  });
});
