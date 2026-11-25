import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { paneCells, selectedPane, type PaneSource } from "./paneMap.ts";

const video = {
  id: "x1",
  kind: "video" as const,
  path: "/home/u/clips/a.mp4",
  mime: "video/mp4",
  size: 1,
};

/** t1 | (t2 の下に x1) と並ぶターミナルのタブ。 */
const source = (over: Partial<PaneSource> = {}): PaneSource => ({
  list: [
    { id: "t1", primary: true },
    { id: "t2", primary: false },
  ],
  extras: [video],
  layout: {
    dir: "right",
    ratio: 0.5,
    a: { pane: "t1" },
    b: { dir: "down", ratio: 0.5, a: { pane: "t2" }, b: { pane: "x1" } },
  },
  titles: { t2: "logs" },
  activeId: "t2",
  ...over,
});

describe("paneCells（ターミナルのタブの窓に出すペインの地図）", () => {
  it("ターミナル、ターミナルでないペインの順に、画面と同じ位置で並べる", () => {
    const cells = paneCells(source(), false);
    assert.deepEqual(
      cells.map((c) => [c.id, c.kind, c.primary]),
      [
        ["t1", "terminal", true],
        ["t2", "terminal", false],
        ["x1", "video", false],
      ],
    );
    assert.deepEqual(cells[0]!.rect, { x: 0, y: 0, w: 0.5, h: 1 });
    assert.deepEqual(cells[2]!.rect, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it("名前（kisui pane title）と、ターミナルでないペインのファイルの名前を持つ", () => {
    const cells = paneCells(source(), false);
    assert.equal(cells[0]!.title, undefined);
    assert.equal(cells[1]!.title, "logs");
    assert.equal(cells[2]!.file, "a.mp4");
    assert.equal(cells[0]!.file, undefined);
  });

  it("キーを向けているペインに active が付く", () => {
    assert.deepEqual(
      paneCells(source(), false).map((c) => c.active),
      [false, true, false],
    );
  });

  it("プライマリ以外を隠している間も全部出し、隠れているペインに hidden を付ける", () => {
    assert.deepEqual(
      paneCells(source(), true).map((c) => c.hidden),
      [false, true, true],
    );
    assert.deepEqual(
      paneCells(source(), false).map((c) => c.hidden),
      [false, false, false],
    );
  });

  it("ペインを出せない（つながっていない）ときは空", () => {
    assert.deepEqual(paneCells(undefined, false), []);
  });
});

describe("selectedPane（窓で選んでいるペイン）", () => {
  const cells = paneCells(source(), false);

  it("選んでいたペインがあれば、そのまま", () => {
    assert.equal(selectedPane(cells, "x1"), "x1");
  });

  it("選んでいない・選んでいたペインが無くなったら、キーを向けているペイン", () => {
    assert.equal(selectedPane(cells, undefined), "t2");
    assert.equal(selectedPane(cells, "gone"), "t2");
  });

  it("キーを向けているペインも無ければ最初のペイン、ペインが無ければ undefined", () => {
    assert.equal(
      selectedPane(paneCells(source({ activeId: undefined }), false), "gone"),
      "t1",
    );
    assert.equal(selectedPane([], "t1"), undefined);
  });
});
