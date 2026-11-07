import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RpcError } from "../rpc/message.ts";
import { changeErrorText, changeRows, letterOf } from "./model.ts";

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
  });
});

describe("changeErrorText", () => {
  it("一覧に無いときは理由を言う", () => {
    const e = new RpcError({ code: -32003, message: "not in the list" });
    assert.match(changeErrorText("/w/a.go", e), /一覧にありません/);
    assert.match(changeErrorText("/w/a.go", new Error("boom")), /boom/);
  });
});
