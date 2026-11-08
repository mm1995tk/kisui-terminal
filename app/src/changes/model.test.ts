import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RpcError } from "../rpc/message.ts";
import { changeErrorText, changeRows, changeTree, letterOf } from "./model.ts";

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
  const rows = changeRows(
    {
      files: [
        { path: "/w/a.go" },
        { path: "/w/pkg/b.go", added: 1 },
        { path: "/w/pkg/sub/c.go" },
        { path: "/w/pkg/d.go" },
        { path: "/other/dir/e.go" },
      ],
      selected: "/w/pkg/b.go",
    },
    "/w",
  );
  const show = (closed: string[] = []) =>
    changeTree(rows, new Set(closed)).map((e) => [
      e.kind,
      e.name,
      e.depth,
      e.expanded,
      e.count,
    ]);

  it("フォルダの木にする。フォルダは最初のファイルが出た所に置く", () => {
    assert.deepEqual(show(), [
      ["file", "a.go", 0, false, 0],
      ["dir", "pkg", 0, true, 3],
      ["file", "b.go", 1, false, 0],
      ["dir", "sub", 1, true, 1],
      ["file", "c.go", 2, false, 0],
      ["file", "d.go", 1, false, 0],
      ["dir", "other", 0, true, 1],
      ["dir", "dir", 1, true, 1],
      ["file", "e.go", 2, false, 0],
    ]);
  });

  it("閉じたフォルダは行を残し、中身を出さない", () => {
    assert.deepEqual(show(["pkg"]), [
      ["file", "a.go", 0, false, 0],
      ["dir", "pkg", 0, false, 3],
      ["dir", "other", 0, true, 1],
      ["dir", "dir", 1, true, 1],
      ["file", "e.go", 2, false, 0],
    ]);
    assert.equal(show(["pkg/sub"]).length, 8);
  });

  it("親の鍵を持つ。外のフォルダは絶対パスが鍵", () => {
    const es = changeTree(rows, new Set());
    assert.equal(es.find((e) => e.name === "c.go")?.parent, "pkg/sub");
    assert.equal(es.find((e) => e.name === "sub")?.parent, "pkg");
    assert.equal(es.find((e) => e.name === "a.go")?.parent, undefined);
    assert.equal(es.find((e) => e.name === "other")?.key, "/other");
  });
});
