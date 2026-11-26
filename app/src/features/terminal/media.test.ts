import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  baseName,
  FILE_MIME,
  fileMime,
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
      "video/webm",
      (r) => seen.push(r),
    );
    assert.deepEqual(calls, [undefined, 4, 8]);
    assert.equal(blob.type, "video/webm");
    assert.equal(await blob.text(), body);
    assert.deepEqual(seen, [0.4, 0.8, 1]);
  });

  it("Blob の type は渡したもので、media.read の返事の mime は使わない", async () => {
    const body = "<p>x</p>";
    const served = async () => ({
      mime: "text/html",
      size: body.length,
      data: b64(body),
      eof: true,
    });
    const signal = new AbortController().signal;
    const pdf = fileMime("pdf", "/a/doc.pdf", "text/html");
    assert.equal(pdf, "application/pdf");
    assert.equal(
      (await loadFile(served, signal, pdf!)).type,
      "application/pdf",
    );
    const png = fileMime("image", "/a/pic.png", "text/html");
    assert.equal(png, "image/png");
    assert.equal((await loadFile(served, signal, png!)).type, "image/png");
    const mp4 = fileMime("video", "/a/clip.mp4", "text/html");
    assert.equal(mp4, "video/mp4");
    assert.equal((await loadFile(served, signal, mp4!)).type, "video/mp4");
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
        "video/mp4",
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
      loadFile(r, new AbortController().signal, "image/png", () => {}, 10),
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
        "video/mp4",
      ),
      /empty chunk/,
    );
  });

  it("中止したら続きを取らない", async () => {
    const ac = new AbortController();
    let n = 0;
    await assert.rejects(
      loadFile(
        async () => {
          n++;
          ac.abort();
          return { mime: "video/mp4", size: 10, data: b64("ab"), eof: false };
        },
        ac.signal,
        "video/mp4",
      ),
    );
    assert.equal(n, 1);
  });
});

describe("fileMime", () => {
  it("ペインの種類と拡張子で決める（serve の言う型より先）", () => {
    assert.equal(fileMime("pdf", "/a/b.PDF", "text/html"), "application/pdf");
    assert.equal(fileMime("image", "/a/b.JPG", "text/html"), "image/jpeg");
    assert.equal(fileMime("image", "/a/b.svg", "image/png"), "image/svg+xml");
    assert.equal(
      fileMime("video", "/a.b/c.mov", "text/html"),
      "video/quicktime",
    );
    assert.equal(fileMime("video", "C:\\a\\c.webm", ""), "video/webm");
  });

  it("拡張子がその種類のものでなければ、serve の言う型がその種類の型のときだけ使う", () => {
    // kisui open が中身から種類を決めたファイル（拡張子が無い・違う）
    assert.equal(fileMime("image", "/a/photo", "image/png"), "image/png");
    assert.equal(
      fileMime("pdf", "/a/doc.bin", "application/pdf"),
      "application/pdf",
    );
    assert.equal(fileMime("video", "/a.mp4/clip", "video/webm"), "video/webm");
    // ほかの種類の型・HTML・空は使わない
    assert.equal(fileMime("pdf", "/a/doc", "text/html"), undefined);
    assert.equal(fileMime("pdf", "/a/doc.html", "text/html"), undefined);
    assert.equal(fileMime("pdf", "/a/doc.png", "image/png"), undefined);
    assert.equal(fileMime("image", "/a/photo", "application/pdf"), undefined);
    assert.equal(fileMime("image", "/a/photo.pdf", ""), undefined);
    assert.equal(fileMime("video", "/a/clip", "image/svg+xml"), undefined);
  });

  it("知らない種類は決めない", () => {
    assert.equal(fileMime("html", "/a/b.html", "text/html"), undefined);
    assert.equal(fileMime("constructor", "/a/b.png", "image/png"), undefined);
    assert.equal(fileMime("", "/a/b.pdf", "application/pdf"), undefined);
  });

  it("拡張子の表は server/filekind.go の fileKinds と同じ", () => {
    const go = readFileSync(
      new URL("../../../../server/filekind.go", import.meta.url),
      "utf8",
    );
    const start = go.indexOf("var fileKinds");
    const table = go.slice(start, go.indexOf("\n}\n", start));
    const want = new Map<string, Map<string, string>>();
    let kind: Map<string, string> | undefined;
    for (const line of table.split("\n")) {
      const k = /^\t"([a-z]+)": \{/.exec(line);
      if (k) want.set(k[1]!, (kind = new Map()));
      for (const m of line.matchAll(/"(\.[a-z0-9]+)":\s*"([^"]+)"/g))
        kind!.set(m[1]!, m[2]!);
    }
    const sorted = (t: ReadonlyMap<string, ReadonlyMap<string, string>>) =>
      [...t]
        .map(([k, v]) => [k, [...v].sort()] as const)
        .sort(([a], [b]) => a.localeCompare(b));
    assert.equal(want.size, 3);
    assert.deepEqual(sorted(FILE_MIME), sorted(want));
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
