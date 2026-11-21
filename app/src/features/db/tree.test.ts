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

  it("開けた枝の下にテーブル・ビューが並ぶ。列の行は出ない", () => {
    const r = visibleRows(catalog, new Set([schemaId("public")]));
    assert.deepEqual(
      r.map((x) => [x.kind, x.label, x.depth]),
      [
        ["schema", "public", 0],
        ["table", "users", 1],
        ["view", "active_users", 1],
        ["schema", "empty", 0],
      ],
    );
    assert.ok(r.every((x) => x.kind !== ("column" as string)));
    // 列のあるテーブルも開けられない（列は Structure で見る）
    assert.equal(r.find((x) => x.label === "users")!.expandable, false);
    assert.equal(r.find((x) => x.label === "users")!.parent, "public");
  });

  it("スキーマが 1 つならそれを開けておく", () => {
    assert.deepEqual(initialExpanded(catalog), []);
    assert.deepEqual(
      initialExpanded({ truncated: false, schemas: [catalog.schemas[0]!] }),
      ["public"],
    );
  });
});

describe("visibleRows の絞り込み（テーブル名）", () => {
  const two: DbCatalog = {
    truncated: false,
    schemas: [
      ...catalog.schemas,
      {
        name: "audit",
        tables: [{ name: "Log_Users", kind: "table", columns: [] }],
      },
    ],
  };
  const labels = (r: ReturnType<typeof visibleRows>) =>
    r.map((x) => [x.kind, x.label]);

  it("名前の一部が合うテーブルだけが残り、そのスキーマは閉じていても開いて出る", () => {
    // どのスキーマも閉じている
    assert.deepEqual(labels(visibleRows(two, new Set(), "users")), [
      ["schema", "public"],
      ["table", "users"],
      ["view", "active_users"],
      ["schema", "audit"],
      ["table", "Log_Users"],
    ]);
    const r = visibleRows(two, new Set(), "users");
    assert.ok(r.filter((x) => x.kind === "schema").every((x) => x.expanded));
  });

  it("大文字と小文字は区別しない", () => {
    assert.deepEqual(labels(visibleRows(two, new Set(), "LOG")), [
      ["schema", "audit"],
      ["table", "Log_Users"],
    ]);
    assert.deepEqual(labels(visibleRows(two, new Set(), "ACTIVE")), [
      ["schema", "public"],
      ["view", "active_users"],
    ]);
  });

  it("合うものが無ければ、行は 1 つも無い（スキーマの名前では絞らない）", () => {
    assert.deepEqual(visibleRows(two, new Set(), "zzz"), []);
    assert.deepEqual(visibleRows(two, new Set(), "public"), []);
  });

  it("空・空白だけなら絞らず、開けている枝のまま", () => {
    const open = new Set([schemaId("public")]);
    for (const f of ["", "  "])
      assert.deepEqual(visibleRows(two, open, f), visibleRows(two, open));
    assert.deepEqual(labels(visibleRows(two, open, "")), [
      ["schema", "public"],
      ["table", "users"],
      ["view", "active_users"],
      ["schema", "empty"],
      ["schema", "audit"],
    ]);
  });

  it("絞り込み中のスキーマは開け閉めできず、h は閉じずに動くだけ（開けている枝を書き換えない）", () => {
    const r = visibleRows(two, new Set(), "users");
    assert.ok(r.filter((x) => x.kind === "schema").every((x) => !x.expandable));
    assert.deepEqual(treeStep(r, "public", "collapse"), {});
    assert.deepEqual(treeStep(r, "audit", "collapse"), {});
    assert.deepEqual(treeStep(r, "public", "expand"), {
      cursor: tableId("public", "users"),
    });
    assert.deepEqual(treeStep(r, tableId("audit", "Log_Users"), "collapse"), {
      cursor: "audit",
    });
  });

  it("前後の空白は無視する", () => {
    assert.deepEqual(
      visibleRows(two, new Set(), " log "),
      visibleRows(two, new Set(), "log"),
    );
  });
});

describe("treeStep（木のキーの動き）", () => {
  const open = new Set([schemaId("public")]);
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
    assert.deepEqual(treeStep(rows, id("users"), "last"), {
      cursor: id("empty"),
    });
    assert.deepEqual(treeStep(rows, id("users"), "first"), {
      cursor: id("public"),
    });
  });

  it("右：閉じていれば開け、開いていれば中へ。テーブルは何もしない", () => {
    const closed = visibleRows(catalog, new Set());
    assert.deepEqual(treeStep(closed, closed[0]!.id, "expand"), {
      toggle: { id: "public", open: true },
    });
    assert.deepEqual(treeStep(rows, id("public"), "expand"), {
      cursor: id("users"),
    });
    assert.deepEqual(treeStep(rows, id("users"), "expand"), {});
  });

  it("左：開いていれば閉じ、閉じていれば上へ", () => {
    assert.deepEqual(treeStep(rows, id("public"), "collapse"), {
      toggle: { id: "public", open: false },
    });
    assert.deepEqual(treeStep(rows, id("users"), "collapse"), {
      cursor: id("public"),
    });
    assert.deepEqual(treeStep(rows, id("active_users"), "collapse"), {
      cursor: id("public"),
    });
    assert.deepEqual(treeStep(rows, id("empty"), "collapse"), {});
  });

  it("Enter：スキーマは開け閉めする（既定のスキーマにはしない。#398）、テーブル・ビューは中身を見る", () => {
    assert.deepEqual(treeStep(rows, id("public"), "enter"), {
      toggle: { id: "public", open: false },
    });
    assert.deepEqual(treeStep(rows, id("empty"), "enter"), {
      toggle: { id: "empty", open: true },
    });
    // 絞り込み中のスキーマは開け閉めできない
    const filtered = visibleRows(catalog, new Set(), "users");
    assert.deepEqual(treeStep(filtered, id("public"), "enter"), {});
    assert.deepEqual(treeStep(rows, id("users"), "enter"), {
      preview: { schema: "public", table: "users" },
    });
    assert.deepEqual(treeStep(rows, id("active_users"), "enter"), {
      preview: { schema: "public", table: "active_users" },
    });
  });

  it("/ は絞り込みの入力欄に移る。行が無くても移れる", () => {
    assert.deepEqual(treeStep(rows, id("users"), "filter"), {
      focusFilter: true,
    });
    assert.deepEqual(treeStep([], undefined, "filter"), { focusFilter: true });
  });

  it("s はドロップダウンに移り、a は「すべてのスキーマを表示」を切り替える。行が無くてもできる（#398）", () => {
    assert.deepEqual(treeStep(rows, id("users"), "schema"), {
      focusSchema: true,
    });
    assert.deepEqual(treeStep([], undefined, "schema"), { focusSchema: true });
    assert.deepEqual(treeStep(rows, id("users"), "all"), { toggleAll: true });
    assert.deepEqual(treeStep([], undefined, "all"), { toggleAll: true });
  });

  it("スキーマを 1 つに絞った木（#398）：テーブルの行だけを上下に動き、Enter で中身を見る。上の行は無い", () => {
    const flat = visibleRows(catalog, new Set(), "", "public");
    assert.deepEqual(treeStep(flat, undefined, "next"), {
      cursor: id("users"),
    });
    assert.deepEqual(treeStep(flat, id("users"), "next"), {
      cursor: id("active_users"),
    });
    assert.deepEqual(treeStep(flat, id("users"), "collapse"), {});
    assert.deepEqual(treeStep(flat, id("users"), "expand"), {});
    assert.deepEqual(treeStep(flat, id("users"), "enter"), {
      preview: { schema: "public", table: "users" },
    });
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

describe("visibleRows（スキーマを 1 つに絞る。#398）", () => {
  it("そのスキーマのテーブル・ビューだけを、スキーマの行なしで並べる（開けている枝は見ない）", () => {
    const r = visibleRows(catalog, new Set(), "", "public");
    assert.deepEqual(
      r.map((x) => [x.kind, x.label, x.depth, x.parent, x.schema]),
      [
        ["table", "users", 0, undefined, "public"],
        ["view", "active_users", 0, undefined, "public"],
      ],
    );
    assert.ok(r.every((x) => !x.expandable));
    assert.equal(r[0]!.id, tableId("public", "users"));
  });

  it("テーブル名の絞り込みは、そのスキーマの中だけを探す", () => {
    const two: DbCatalog = {
      truncated: false,
      schemas: [
        ...catalog.schemas,
        {
          name: "audit",
          tables: [{ name: "users_log", kind: "table", columns: [] }],
        },
      ],
    };
    assert.deepEqual(
      visibleRows(two, new Set(), "USERS", "public").map((x) => x.label),
      ["users", "active_users"],
    );
    assert.deepEqual(
      visibleRows(two, new Set(), "log", "public").map((x) => x.label),
      [],
    );
    // 絞らなければ、すべてのスキーマから探す
    assert.deepEqual(
      visibleRows(two, new Set(), "log").map((x) => x.label),
      ["audit", "users_log"],
    );
  });

  it("テーブルの無いスキーマ・一覧に無いスキーマは、何も並ばない", () => {
    assert.deepEqual(visibleRows(catalog, new Set(), "", "empty"), []);
    assert.deepEqual(visibleRows(catalog, new Set(), "", "gone"), []);
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
