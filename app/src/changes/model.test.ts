import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RpcError } from "../rpc/message.ts";
import {
  changeErrorText,
  changeRows,
  changesBaseLabel,
  changesBaseOf,
  changeTree,
  letterOf,
} from "./model.ts";

describe("changeRows", () => {
  it("root の中は相対パスにし、外は絶対パスのまま出す。選んでいるファイルに印を付ける", () => {
    const rows = changeRows(
      {
        files: [
          { path: "/w/a.go", status: "modified", added: 2, deleted: 1 },
          { path: "/w/pkg/b.go", status: "added", added: 5 },
          { path: "/other/c.go", status: "deleted", deleted: 3 },
        ],
        selected: "/w/pkg/b.go",
      },
      "/w",
    );
    assert.deepEqual(
      rows.map((r) => [
        r.name,
        r.dir,
        r.letter,
        r.added,
        r.deleted,
        r.selected,
      ]),
      [
        ["a.go", "", "M", 2, 1, false],
        ["b.go", "pkg", "A", 5, 0, true],
        ["c.go", "/other", "D", 0, 3, false],
      ],
    );
    assert.equal(rows[1].path, "/w/pkg/b.go");
  });

  it("root の名前だけが同じ別のフォルダは中とみなさない", () => {
    const [r] = changeRows({ files: [{ path: "/work/a.go" }] }, "/w");
    assert.equal(r.dir, "/work");
    assert.equal(r.letter, "M");
  });

  it("空の一覧は空の行", () => {
    assert.deepEqual(changeRows({ files: [] }, "/w"), []);
  });
});

describe("letterOf", () => {
  it("知らない状態は変更", () => {
    assert.deepEqual(letterOf("renamed"), ["R", "名前変更"]);
    assert.deepEqual(letterOf("binary"), ["B", "バイナリ"]);
    assert.deepEqual(letterOf("whatever"), ["M", "変更"]);
    assert.deepEqual(letterOf(undefined), ["M", "変更"]);
    assert.deepEqual(letterOf("toString"), ["M", "変更"]);
    assert.deepEqual(letterOf("constructor"), ["M", "変更"]);
  });
});

describe("changeErrorText", () => {
  it("一覧に無いときは理由を言う", () => {
    const e = new RpcError({ code: -32003, message: "not in the list" });
    assert.match(changeErrorText("/w/a.go", e), /一覧にありません/);
    assert.match(changeErrorText("/w/a.go", new Error("boom")), /boom/);
  });
});

describe("changeTree", () => {
  const tree = (paths: string[], closed: string[] = [], selected?: string) =>
    changeTree(
      changeRows({ files: paths.map((path) => ({ path })), selected }, "/w"),
      new Set(closed),
    );
  const show = (es: ReturnType<typeof tree>) =>
    es.map((e) => [e.kind, e.name, e.depth, e.expanded, e.count]);
  const rows = [
    "/w/a.go",
    "/w/pkg/b.go",
    "/w/pkg/sub/c.go",
    "/w/pkg/d.go",
    "/other/dir/e.go",
  ];

  it("フォルダの木にする。フォルダは最初のファイルが出た所に置く", () => {
    assert.deepEqual(show(tree(rows)), [
      ["file", "a.go", 0, false, 0],
      ["dir", "pkg", 0, true, 3],
      ["file", "b.go", 1, false, 0],
      ["dir", "sub", 1, true, 1],
      ["file", "c.go", 2, false, 0],
      ["file", "d.go", 1, false, 0],
      ["dir", "other/dir", 0, true, 1],
      ["file", "e.go", 1, false, 0],
    ]);
  });

  it("ファイルが無く子のフォルダが 1 つだけのフォルダは 1 行にまとめる（TUI と同じ）", () => {
    const es = tree(["/w/app/src/changes/keys.ts"]);
    assert.deepEqual(show(es), [
      ["dir", "app/src/changes", 0, true, 1],
      ["file", "keys.ts", 1, false, 0],
    ]);
    assert.equal(es[0].key, "app/src/changes");
    assert.equal(es[1].parent, "app/src/changes");
  });

  it("まとめない：フォルダにファイルもある・子のフォルダが 2 つ", () => {
    assert.deepEqual(
      show(tree(["/w/a/x.go", "/w/a/b/y.go"])).map((r) => r[1]),
      ["a", "x.go", "b", "y.go"],
    );
    assert.deepEqual(
      show(tree(["/w/a/b/x.go", "/w/a/c/y.go"])).map((r) => r[1]),
      ["a", "b", "x.go", "c", "y.go"],
    );
  });

  it("まとめた先に続く枝も、同じ規則でまとめる", () => {
    assert.deepEqual(
      show(tree(["/w/a/b/c/x.go", "/w/a/b/d/y.go"])).map((r) => r[1]),
      ["a/b", "c", "x.go", "d", "y.go"],
    );
  });

  it("閉じたフォルダは行を残し、中身を出さない（まとめた行は一番深い鍵で閉じる）", () => {
    assert.deepEqual(show(tree(rows, ["pkg"])), [
      ["file", "a.go", 0, false, 0],
      ["dir", "pkg", 0, false, 3],
      ["dir", "other/dir", 0, true, 1],
      ["file", "e.go", 1, false, 0],
    ]);
    assert.equal(tree(rows, ["pkg/sub"]).length, 7);
    assert.equal(tree(["/w/a/b/x.go"], ["a/b"]).length, 1);
  });

  it("親の鍵を持つ。外のフォルダは絶対パスが鍵", () => {
    const es = tree(rows);
    assert.equal(es.find((e) => e.name === "c.go")?.parent, "pkg/sub");
    assert.equal(es.find((e) => e.name === "sub")?.parent, "pkg");
    assert.equal(es.find((e) => e.name === "a.go")?.parent, undefined);
    assert.equal(es.find((e) => e.name === "other/dir")?.key, "/other/dir");
  });

  it("差分を出しているファイルが閉じたフォルダの中なら、そのフォルダの行に印を付ける", () => {
    const held = (closed: string[]) =>
      tree(rows, closed, "/w/pkg/sub/c.go")
        .filter((e) => e.holdsSelected)
        .map((e) => e.name);
    assert.deepEqual(held([]), []);
    assert.deepEqual(held(["pkg"]), ["pkg"]);
    assert.deepEqual(held(["pkg/sub"]), ["sub"]);
  });
});

describe("changesBaseOf（比べている相手。Issue #46）", () => {
  it("pr は PR、無いときと知らない値は HEAD", () => {
    assert.equal(changesBaseOf({ base: "pr" }), "pr");
    assert.equal(changesBaseOf({ base: "head" }), "head");
    assert.equal(changesBaseOf({}), "head");
    assert.equal(changesBaseOf({ base: "x" as never }), "head");
    assert.equal(changesBaseLabel("pr"), "PR");
    assert.equal(changesBaseLabel("head"), "HEAD");
  });
});
