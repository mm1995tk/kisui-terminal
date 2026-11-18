import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  baseName,
  loadFile,
  MAX_BYTES,
  MAX_VIDEO_BYTES,
  tooLarge,
  seekTo,
  videoKey,
} from "./media.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("loadFile", () => {
  it("eof まで offset をずらして取り、1 つの Blob にする", async () => {
    const body = "0123456789";
    const calls: (number | undefined)[] = [];
    const seen: number[] = [];
    const blob = await loadFile(
      async ({ offset }) => {
        calls.push(offset);
        const at = offset ?? 0;
        const data = body.slice(at, at + 4);
        return {
          mime: "video/webm",
          size: body.length,
          data: b64(data),
          eof: at + data.length >= body.length,
        };
      },
      new AbortController().signal,
      (r) => seen.push(r),
    );
    assert.deepEqual(calls, [undefined, 4, 8]);
    assert.equal(blob.type, "video/webm");
    assert.equal(await blob.text(), body);
    assert.deepEqual(seen, [0.4, 0.8, 1]);
  });

  it("大きすぎる動画は取らない", async () => {
    await assert.rejects(
      loadFile(
        async () => ({
          mime: "video/mp4",
          size: MAX_VIDEO_BYTES + 1,
          data: "",
          eof: false,
        }),
        new AbortController().signal,
      ),
      /too large/,
    );
  });

  it("種類ごとの上限で断る", async () => {
    const r = async () => ({
      mime: "image/png",
      size: 11,
      data: "",
      eof: false,
    });
    await assert.rejects(
      loadFile(r, new AbortController().signal, () => {}, 10),
      /too large/,
    );
    assert.equal(tooLarge("image", MAX_BYTES.image! + 1), true);
    assert.equal(tooLarge("image", MAX_BYTES.image!), false);
    assert.equal(tooLarge("video", MAX_BYTES.image! + 1), false);
    assert.equal(tooLarge("pdf", MAX_BYTES.pdf! + 1), true);
  });

  it("進まなければ打ち切る", async () => {
    await assert.rejects(
      loadFile(
        async () => ({ mime: "video/mp4", size: 10, data: "", eof: false }),
        new AbortController().signal,
      ),
      /empty chunk/,
    );
  });

  it("中止したら続きを取らない", async () => {
    const ac = new AbortController();
    let n = 0;
    await assert.rejects(
      loadFile(async () => {
        n++;
        ac.abort();
        return { mime: "video/mp4", size: 10, data: b64("ab"), eof: false };
      }, ac.signal),
    );
    assert.equal(n, 1);
  });
});

describe("操作", () => {
  const k = (key: string, o: object = {}) =>
    videoKey({
      key,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      ...o,
    });
  it("キーを動画の操作にする", () => {
    assert.deepEqual(k(" "), { kind: "toggle" });
    assert.deepEqual(k("ArrowLeft"), { kind: "seek", dt: -5 });
    assert.deepEqual(k("l"), { kind: "seek", dt: 10 });
    assert.deepEqual(k("m"), { kind: "mute" });
    assert.equal(k("x"), null);
    // GUI のショートカット（Cmd+D・リーダーなど）は動画で受けない
    assert.equal(k("ArrowLeft", { ctrlKey: true, shiftKey: true }), null);
    assert.equal(k("k", { metaKey: true }), null);
  });
  it("再生位置は 0 から長さまで", () => {
    assert.equal(seekTo(3, -5, 100), 0);
    assert.equal(seekTo(98, 5, 100), 100);
    assert.equal(seekTo(10, 5, NaN), 15);
  });
  it("見出しはパスの最後の名前", () => {
    assert.equal(baseName("/a/b/c.mp4"), "c.mp4");
    assert.equal(baseName("c.mp4"), "c.mp4");
  });
});
