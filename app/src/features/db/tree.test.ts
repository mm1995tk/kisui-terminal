import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DbCatalog } from "../../infrastructure/rpc/protocol.ts";
import {
  initialExpanded,
  previewSql,
  quoteIdent,
  schemaId,
  tableId,
  treeStep,
  keepDefaultSchema,
  visibleRows,
  withDefaultSchema,
} from "./tree.ts";

const catalog: DbCatalog = {
  truncated: false,
  schemas: [
    {
      name: "public",
      tables: [
        {
          name: "users",
          kind: "table",
          columns: [
            { name: "id", type: "integer" },
            { name: "name", type: "text" },
          ],
        },
        { name: "active_users", kind: "view", columns: [] },
      ],
    },
    { name: "empty", tables: [] },
  ],
};

describe("visibleRows（木の見える行）", () => {
  it("閉じていればスキーマだけ", () => {
    const r = visibleRows(catalog, new Set());
    assert.deepEqual(
      r.map((x) => [x.kind, x.label, x.depth]),
      [
        ["schema", "public", 0],
        ["schema", "empty", 0],
      ],
    );
  });

  it("開けた枝の下に、テーブル・ビュー・列が並ぶ", () => {
    const r = visibleRows(
      catalog,
      new Set([schemaId("public"), tableId("public", "users")]),
    );
    assert.deepEqual(
      r.map((x) => [x.kind, x.label, x.type]),
      [
        ["schema", "public", undefined],
        ["table", "users", undefined],
        ["column", "id", "integer"],
        ["column", "name", "text"],
        ["view", "active_users", undefined],
        ["schema", "empty", undefined],
      ],
    );
    const users = r.find((x) => x.label === "users")!;
    assert.equal(users.expanded, true);
    assert.equal(users.parent, "public");
  });

  it("列の無いテーブルは、開けられない", () => {
    const r = visibleRows(catalog, new Set([schemaId("public")]));
    assert.equal(r.find((x) => x.label === "active_users")!.expandable, false);
    assert.equal(r.find((x) => x.label === "users")!.expandable, true);
  });

  it("スキーマが 1 つならそれを開けておく", () => {
    assert.deepEqual(initialExpanded(catalog), []);
    assert.deepEqual(
      initialExpanded({ truncated: false, schemas: [catalog.schemas[0]!] }),
      ["public"],
    );
  });
});

describe("treeStep（木のキーの動き）", () => {
  const open = new Set([schemaId("public"), tableId("public", "users")]);
  const rows = visibleRows(catalog, open);
  const id = (label: string) => rows.find((r) => r.label === label)!.id;

  it("上下は端で止まる。選んでいる行が無ければ先頭から", () => {
    assert.deepEqual(treeStep(rows, undefined, "next"), {
      cursor: rows[0]!.id,
    });
    assert.deepEqual(treeStep(rows, id("public"), "next"), {
      cursor: id("users"),
    });
    assert.deepEqual(treeStep(rows, id("public"), "prev"), {
      cursor: id("public"),
    });
    assert.deepEqual(treeStep(rows, id("empty"), "next"), {
      cursor: id("empty"),
    });
    assert.deepEqual(treeStep(rows, id("id"), "last"), { cursor: id("empty") });
    assert.deepEqual(treeStep(rows, id("id"), "first"), {
      cursor: id("public"),
    });
  });

  it("右：閉じていれば開け、開いていれば中へ。列は何もしない", () => {
    const closed = visibleRows(catalog, new Set());
    assert.deepEqual(treeStep(closed, closed[0]!.id, "expand"), {
      toggle: { id: "public", open: true },
    });
    assert.deepEqual(treeStep(rows, id("public"), "expand"), {
      cursor: id("users"),
    });
    assert.deepEqual(treeStep(rows, id("id"), "expand"), {});
  });

  it("左：開いていれば閉じ、閉じていれば上へ", () => {
    assert.deepEqual(treeStep(rows, id("users"), "collapse"), {
      toggle: { id: id("users"), open: false },
    });
    assert.deepEqual(treeStep(rows, id("id"), "collapse"), {
      cursor: id("users"),
    });
    assert.deepEqual(treeStep(rows, id("active_users"), "collapse"), {
      cursor: id("public"),
    });
    assert.deepEqual(treeStep(rows, id("empty"), "collapse"), {});
  });

  it("Enter：スキーマは既定のスキーマにする、テーブル・ビューは中身を見る、列は何もしない", () => {
    // 開いているスキーマは開いたまま、閉じているスキーマは開ける（#378）
    assert.deepEqual(treeStep(rows, id("public"), "enter"), {
      setDefaultSchema: "public",
    });
    assert.deepEqual(treeStep(rows, id("empty"), "enter", "public"), {
      setDefaultSchema: "empty",
      toggle: { id: "empty", open: true },
    });
    // もう既定のスキーマなら、既定をやめる（開け閉めはしない）
    assert.deepEqual(treeStep(rows, id("public"), "enter", "public"), {
      setDefaultSchema: null,
    });
    assert.deepEqual(treeStep(rows, id("users"), "enter"), {
      preview: { schema: "public", table: "users" },
    });
    assert.deepEqual(treeStep(rows, id("active_users"), "enter"), {
      preview: { schema: "public", table: "active_users" },
    });
    assert.deepEqual(treeStep(rows, id("id"), "enter"), {});
  });

  it("Esc は入力欄に戻る。行が無くても戻れる", () => {
    assert.deepEqual(treeStep([], undefined, "back"), { leave: true });
    assert.deepEqual(treeStep([], undefined, "next"), {});
  });
});

describe("previewSql（テーブルを選んだときの SQL）", () => {
  it("PostgreSQL は二重引用符、MySQL はバッククォートで、スキーマも付ける", () => {
    assert.equal(
      previewSql("postgres", "public", "users"),
      'SELECT * FROM "public"."users" LIMIT 100',
    );
    assert.equal(
      previewSql("mysql", "shop", "users"),
      "SELECT * FROM `shop`.`users` LIMIT 100",
    );
  });

  it("名前の中の引用符は 2 つにする", () => {
    assert.equal(quoteIdent("postgres", 'a"b'), '"a""b"');
    assert.equal(quoteIdent("mysql", "a`b"), "`a``b`");
    assert.equal(quoteIdent("mysql", 'a"b'), '`a"b`');
  });
});

describe("withDefaultSchema（タブの既定のスキーマ。#378）", () => {
  it("選んだタブの分だけを変え、ほかのタブの分は残す", () => {
    const all = { a: "app", b: "public" };
    assert.deepEqual(withDefaultSchema(all, "a", "audit"), {
      a: "audit",
      b: "public",
    });
    assert.deepEqual(withDefaultSchema(all, "c", "x"), {
      a: "app",
      b: "public",
      c: "x",
    });
    assert.deepEqual(all, { a: "app", b: "public" });
  });

  it("null はそのタブの分を除く（DB の既定に戻す）", () => {
    assert.deepEqual(withDefaultSchema({ a: "app", b: "x" }, "a", null), {
      b: "x",
    });
    assert.deepEqual(withDefaultSchema({}, "a", null), {});
  });
});

describe("keepDefaultSchema（読み直したあとも既定のスキーマを残すか。#378）", () => {
  it("一覧にあれば残し、無ければ捨てる", () => {
    assert.equal(keepDefaultSchema(catalog, "empty"), true);
    assert.equal(keepDefaultSchema(catalog, "gone"), false);
  });

  it("一覧が途中で切れていれば、無くても残す（無いとは言えない）", () => {
    assert.equal(
      keepDefaultSchema({ ...catalog, truncated: true }, "gone"),
      true,
    );
  });
});
