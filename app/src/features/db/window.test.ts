import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DbQueryResult } from "../../infrastructure/rpc/protocol.ts";
import { resultSummary } from "./model.ts";
import type { DbRun } from "./results.ts";
import type { DbStructureState } from "./structure.ts";
import {
  dbWindowRows,
  selectedResult,
  stepResult,
  type DbWindowRow,
} from "./window.ts";

const result: DbQueryResult = {
  columns: [{ name: "id", type: "int4", kind: "number" }],
  rows: [["1"]],
  rowCount: 1,
  truncated: false,
  elapsedMs: 3,
};

const none = () => undefined;

describe("dbWindowRows", () => {
  it("結果のタブを左から順に並べ、状態と印を付ける", () => {
    const run: DbRun = {
      tabs: [
        { id: "r1", sql: "SELECT 1", result },
        { id: "r2", sql: "SELECT pg_sleep(9)" },
        { id: "r3", sql: "SELECT x", failure: { kind: "cancelled" } },
        {
          id: "r4",
          sql: "SELEC",
          failure: { kind: "error", message: "syntax", sqlState: "42601" },
        },
        { id: "r5", sql: "SELECT 2" },
      ],
      active: "r1",
      running: { queryId: "q", target: "local", tab: "r2" },
    };
    const rows = dbWindowRows(run, none);
    assert.deepEqual(
      rows.map((r) => [r.id, r.name, r.state, r.shown]),
      [
        [
          "r1",
          "SELECT 1",
          { kind: "done", summary: resultSummary(result) },
          true,
        ],
        ["r2", "SELECT pg_sleep(9)", { kind: "running" }, false],
        ["r3", "SELECT x", { kind: "cancelled" }, false],
        ["r4", "SELEC", { kind: "error", sqlState: "42601" }, false],
        ["r5", "SELECT 2", { kind: "none" }, false],
      ],
    );
  });

  it("木で選んだテーブルの名前と、仮のタブ・Structure の印を付ける", () => {
    const run: DbRun = {
      tabs: [
        {
          id: "r1",
          sql: 'SELECT * FROM "public"."users" LIMIT 100',
          label: "users",
          result,
        },
      ],
      active: "r1",
      preview: "r1",
    };
    const s: DbStructureState = {
      table: { schema: "public", table: "users" },
      view: "structure",
    };
    const [row] = dbWindowRows(run, (tab) => (tab === "r1" ? s : undefined));
    assert.equal(row!.name, "users");
    assert.equal(row!.preview, true);
    assert.equal(row!.table, "public.users");
    assert.equal(row!.structure, true);
  });

  it("結果のタブが無ければ空", () => {
    assert.deepEqual(dbWindowRows({ tabs: [] }, none), []);
  });
});

const row = (id: string, shown = false): DbWindowRow => ({
  id,
  name: id,
  state: { kind: "none" },
  shown,
  preview: false,
  structure: false,
});

describe("selectedResult", () => {
  const rows = [row("a"), row("b", true), row("c")];
  it("選んだ行がまだあれば、それ", () => {
    assert.equal(selectedResult(rows, "c"), "c");
  });
  it("初めと、選んだ行が無くなったときは、出しているタブ", () => {
    assert.equal(selectedResult(rows, undefined), "b");
    assert.equal(selectedResult(rows, "gone"), "b");
  });
  it("出しているタブも無ければ先頭、行が無ければ undefined", () => {
    assert.equal(selectedResult([row("a"), row("b")], undefined), "a");
    assert.equal(selectedResult([], "a"), undefined);
  });
});

describe("stepResult", () => {
  const rows = [row("a"), row("b"), row("c")];
  it("上下に 1 つ動き、端では止まる", () => {
    assert.equal(stepResult(rows, "b", 1), "c");
    assert.equal(stepResult(rows, "c", 1), "c");
    assert.equal(stepResult(rows, "b", -1), "a");
    assert.equal(stepResult(rows, "a", -1), "a");
  });
});
