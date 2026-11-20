import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DbStructure,
  DbStructureForeignKey,
} from "../../infrastructure/rpc/protocol.ts";
import {
  forgetStructure,
  indexKindText,
  keyColumnsText,
  needsStructure,
  otherView,
  referenceText,
  selectTable,
  type DbStructureState,
} from "./structure.ts";

const structure: DbStructure = {
  columns: [{ name: "id", type: "integer", nullable: false, default: null }],
  indexes: [],
  foreignKeys: [],
  truncated: false,
};
const users = { schema: "public", table: "users" };
const posts = { schema: "public", table: "posts" };

describe("selectTable（木でテーブルを選ぶ。#379）", () => {
  it("初めて選んだら、データの側を出す", () => {
    assert.deepEqual(selectTable(undefined, users), {
      table: users,
      view: "data",
    });
  });

  it("違うテーブルを選んだら、出している側は残し、前の構造は捨てる", () => {
    const cur: DbStructureState = {
      table: users,
      view: "structure",
      structure,
    };
    assert.deepEqual(selectTable(cur, posts), {
      table: posts,
      view: "structure",
    });
  });

  it("同じテーブルを選び直したら、聞いた構造を残す", () => {
    const cur: DbStructureState = {
      table: users,
      view: "structure",
      structure,
    };
    assert.equal(selectTable(cur, { ...users }), cur);
  });
});

describe("needsStructure（構造を聞きに行くか）", () => {
  it("Structure を出していて、まだ聞いていなければ聞く", () => {
    assert.equal(needsStructure({ table: users, view: "structure" }), true);
  });

  it("データの側・聞いた後・聞いている最中・失敗の後・テーブルを選んでいないときは聞かない", () => {
    assert.equal(needsStructure(undefined), false);
    assert.equal(needsStructure({ table: users, view: "data" }), false);
    assert.equal(
      needsStructure({ table: users, view: "structure", structure }),
      false,
    );
    assert.equal(
      needsStructure({
        table: users,
        view: "structure",
        loading: { queryId: "q", target: "local" },
      }),
      false,
    );
    assert.equal(
      needsStructure({ table: users, view: "structure", error: "no" }),
      false,
    );
  });

  it("聞き直す（forgetStructure）と、また聞く", () => {
    const s = forgetStructure({
      table: users,
      view: "structure",
      error: "no",
    });
    assert.equal(needsStructure(s), true);
    assert.equal(
      needsStructure(
        forgetStructure({ table: users, view: "structure", structure }),
      ),
      true,
    );
  });
});

describe("otherView", () => {
  it("データと Structure を行き来する", () => {
    assert.equal(otherView("data"), "structure");
    assert.equal(otherView("structure"), "data");
  });
});

describe("表のセルの文字", () => {
  it("キーの列はカンマで並べ、名前の無い式のキーは (…) にする", () => {
    assert.equal(keyColumnsText(["a", "b"]), "a, b");
    assert.equal(keyColumnsText(["a", ""]), "a, (…)");
  });

  it("インデックスの種類は、主キー・一意・どちらでもない", () => {
    const words = { primary: "PK", unique: "U" };
    const ix = { name: "i", columns: ["a"], method: "btree" };
    assert.equal(
      indexKindText({ ...ix, primary: true, unique: true }, words),
      "PK",
    );
    assert.equal(
      indexKindText({ ...ix, primary: false, unique: true }, words),
      "U",
    );
    assert.equal(
      indexKindText({ ...ix, primary: false, unique: false }, words),
      "",
    );
  });

  it("外部キーの参照先は、同じスキーマならスキーマを省く", () => {
    const fk: DbStructureForeignKey = {
      name: "fk",
      columns: ["user_id"],
      refSchema: "public",
      refTable: "users",
      refColumns: ["id"],
      onUpdate: "NO ACTION",
      onDelete: "CASCADE",
    };
    assert.equal(referenceText(fk, "public"), "users (id)");
    assert.equal(referenceText(fk, "other"), "public.users (id)");
  });
});
