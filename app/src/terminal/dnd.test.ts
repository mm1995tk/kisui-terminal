import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { locate, offeredMimes, resolveRequest, type DropItem } from "./dnd.ts";

describe("offeredMimes", () => {
  it("テキスト系が先、ファイルがあと。Files は除く", () => {
    assert.deepEqual(
      offeredMimes(
        ["Files", "text/plain"],
        [
          { kind: "string", type: "text/plain" },
          { kind: "file", type: "image/png" },
          { kind: "file", type: "" },
        ],
      ),
      ["text/plain", "image/png", "application/octet-stream"],
    );
  });
});

describe("locate", () => {
  const rect = { left: 10, top: 20 };
  const cell = { width: 8, height: 16 };
  const grid = { cols: 10, rows: 5 };
  it("セルと画素のずれ", () => {
    assert.deepEqual(locate(rect, cell, grid, { x: 29, y: 60 }), {
      x: 2,
      y: 2,
      pixelX: 3,
      pixelY: 8,
    });
  });
  it("はみ出したら端に寄せる", () => {
    const l = locate(rect, cell, grid, { x: 5000, y: 5000 });
    assert.equal(l.x, 9);
    assert.equal(l.y, 4);
    const m = locate(rect, cell, grid, { x: 0, y: 0 });
    assert.deepEqual(m, { x: 0, y: 0, pixelX: 0, pixelY: 0 });
  });
});

describe("resolveRequest", () => {
  const items: DropItem[] = [
    { mime: "text/plain", read: async () => new Uint8Array() },
  ];
  it("番号は 1 始まり", () => {
    const r = resolveRequest({ type: "data", index: 1 }, items);
    assert.equal(r.kind, "data");
    assert.deepEqual(resolveRequest({ type: "data", index: 2 }, items), {
      kind: "error",
      error: "ENOENT",
    });
  });
  it("ディレクトリや遠くの項目は断る。close は答えない", () => {
    assert.deepEqual(
      resolveRequest({ type: "entry", index: 1, subIndex: 1 }, items),
      { kind: "error", error: "EINVAL" },
    );
    assert.deepEqual(resolveRequest({ type: "dirClose", handle: 2 }, items), {
      kind: "none",
    });
  });
});
