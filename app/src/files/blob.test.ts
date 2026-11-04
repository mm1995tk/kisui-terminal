import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ImageRef } from "../rpc/protocol.ts";
import {
  BlobStore,
  blobKey,
  decodeBase64,
  fetchBlob,
  type BlobFetch,
} from "./blob.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");

/** data を chunk バイトずつ返す blob.get。呼ばれたパラメータを calls に残す。 */
function fakeGet(
  data: string,
  chunk: number,
  calls: unknown[] = [],
): BlobFetch {
  return async (p) => {
    calls.push(p);
    if (p.id === "missing") throw new Error("not_found");
    const off = p.offset ?? 0;
    const part = data.slice(off, off + chunk);
    return {
      mime: "image/png",
      size: data.length,
      data: b64(part),
      eof: off + part.length >= data.length,
    };
  };
}

const ref = (blob: string, more: Partial<ImageRef> = {}): ImageRef => ({
  blob,
  width: 10,
  height: 20,
  ...more,
});

describe("decodeBase64", () => {
  it("バイト列に戻す", () => {
    assert.deepEqual([...decodeBase64(b64("abc"))], [97, 98, 99]);
  });
});

describe("fetchBlob", () => {
  it("eof まで offset をずらして分けて取り、つなぐ", async () => {
    const calls: unknown[] = [];
    const r = await fetchBlob(fakeGet("abcdefg", 3, calls), "file:/a.png");
    assert.equal(new TextDecoder().decode(r.bytes), "abcdefg");
    assert.equal(r.mime, "image/png");
    assert.deepEqual(calls, [
      { id: "file:/a.png" },
      { id: "file:/a.png", offset: 3 },
      { id: "file:/a.png", offset: 6 },
    ]);
  });

  it("空の塊が来て終わらないときは打ち切る", async () => {
    const get: BlobFetch = async () => ({
      mime: "image/png",
      size: 10,
      data: "",
      eof: false,
    });
    await assert.rejects(fetchBlob(get, "x"));
  });
});

describe("BlobStore", () => {
  function store(calls: unknown[], max?: number) {
    const revoked: string[] = [];
    let n = 0;
    const s = new BlobStore(fakeGet("data", 100, calls), {
      max,
      makeUrl: () => `blob:${++n}`,
      revokeUrl: (u) => revoked.push(u),
    });
    return { s, revoked };
  }

  it("同じ画像は 1 回だけ取る（取っている最中も分け合う）", async () => {
    const calls: unknown[] = [];
    const { s } = store(calls);
    const [a, b] = await Promise.all([
      s.url(ref("file:/a")),
      s.url(ref("file:/a")),
    ]);
    assert.equal(a, "blob:1");
    assert.equal(b, "blob:1");
    assert.equal(calls.length, 1);
  });

  it("大きさか容量が変われば取り直す", async () => {
    const calls: unknown[] = [];
    const { s } = store(calls);
    await s.url(ref("file:/a"));
    await s.url(ref("file:/a", { size: 99 }));
    assert.equal(calls.length, 2);
    assert.notEqual(blobKey(ref("a")), blobKey(ref("a", { width: 11 })));
  });

  it("取れなかったものは覚えない", async () => {
    const calls: unknown[] = [];
    const { s } = store(calls);
    await assert.rejects(s.url(ref("missing")));
    await assert.rejects(s.url(ref("missing")));
    assert.equal(calls.length, 2);
  });

  it("あふれたら古いものの URL を手放す。clear で全部手放す", async () => {
    const calls: unknown[] = [];
    const { s, revoked } = store(calls, 2);
    await s.url(ref("file:/a"));
    await s.url(ref("file:/b"));
    await s.url(ref("file:/a")); // a を新しくする
    await s.url(ref("file:/c")); // b があふれる
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(revoked, ["blob:2"]);
    s.clear();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(revoked.sort(), ["blob:1", "blob:2", "blob:3"]);
  });
});
