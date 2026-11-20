import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DbQueryResult } from "../../infrastructure/rpc/protocol.ts";
import {
  ariaSort,
  canStep,
  firstPage,
  MAX_QUEUED_STEPS,
  nextSort,
  pageable,
  pageParams,
  pageTarget,
  queueStep,
  rowRange,
  sendQueued,
  sortable,
  sortedPage,
  steppedPage,
  type PageStep,
} from "./paging.ts";

const result = (extra: Partial<DbQueryResult>): DbQueryResult => ({
  columns: [{ name: "n", type: "integer", kind: "number" }],
  rows: [],
  rowCount: 1000,
  truncated: false,
  elapsedMs: 1,
  ...extra,
});

describe("pageable（ページ送りを出すか）", () => {
  it("包める文で、後ろに行が残っているか、先頭のページでないとき", () => {
    assert.equal(pageable(result({ wrappable: true, truncated: true })), true);
    assert.equal(
      pageable(result({ wrappable: true, offset: 1000, rowCount: 5 })),
      true,
    );
  });
  it("1 ページに収まる結果・包めない文・古い kisui serve（wrappable が無い）では出さない", () => {
    assert.equal(pageable(result({ wrappable: true })), false);
    assert.equal(pageable(result({ truncated: true })), false);
    assert.equal(
      pageable(result({ wrappable: false, truncated: true })),
      false,
    );
  });
});

describe("pageTarget（次・前のページの offset）", () => {
  const sql = "SELECT * FROM t";
  it("次は、今のページの行数だけ先。今の offset を戻り先に積む", () => {
    const r = result({ wrappable: true, truncated: true });
    assert.deepEqual(pageTarget(r, { sql, back: [] }, "next"), {
      offset: 1000,
      back: [0],
    });
    // 8 MiB の上限で 1 ページが 1000 行より少ないときも、読んだ行の続きから
    const cut = result({
      wrappable: true,
      truncated: true,
      offset: 1000,
      rowCount: 600,
    });
    assert.deepEqual(pageTarget(cut, { sql, back: [0] }, "next"), {
      offset: 1600,
      back: [0, 1000],
    });
  });
  it("前は、積んだ戻り先の最後", () => {
    const r = result({ wrappable: true, offset: 1600, rowCount: 3 });
    assert.deepEqual(pageTarget(r, { sql, back: [0, 1000] }, "prev"), {
      offset: 1000,
      back: [0],
    });
  });
  it("端のページ・ページ送りの無い結果では null", () => {
    const first = result({ wrappable: true, truncated: true });
    assert.equal(pageTarget(first, { sql, back: [] }, "prev"), null);
    assert.equal(canStep(first, { sql, back: [] }, "prev"), false);
    const last = result({ wrappable: true, offset: 1000, rowCount: 3 });
    assert.equal(pageTarget(last, { sql, back: [0] }, "next"), null);
    assert.equal(canStep(last, { sql, back: [0] }, "prev"), true);
    const notWrappable = result({ truncated: true });
    assert.equal(pageTarget(notWrappable, { sql, back: [] }, "next"), null);
  });
});

describe("rowRange（何行目から何行目か）", () => {
  it("1 から数える。行が無ければ null", () => {
    assert.deepEqual(rowRange(result({})), { from: 1, to: 1000 });
    assert.deepEqual(rowRange(result({ offset: 1000, rowCount: 5 })), {
      from: 1001,
      to: 1005,
    });
    assert.equal(rowRange(result({ rowCount: 0 })), null);
  });
});

describe("queueStep（読み込み中に押した向きを覚える）", () => {
  it("押した順に後ろへ足す", () => {
    assert.deepEqual(queueStep(queueStep([], "next"), "prev"), [
      "next",
      "prev",
    ]);
  });
  it("上限に達したら足さない", () => {
    const full: PageStep[] = Array(MAX_QUEUED_STEPS).fill("next");
    assert.equal(queueStep(full.slice(1), "prev").length, MAX_QUEUED_STEPS);
    assert.deepEqual(queueStep(full, "prev"), full);
  });
});

describe("sendQueued（結果が来たら 1 つ送る）", () => {
  it("先頭を送り、残りを返す", () => {
    const sent: PageStep[] = [];
    const rest = sendQueued(["next", "next", "prev"], (s) => {
      sent.push(s);
      return true;
    });
    assert.deepEqual(sent, ["next"]);
    assert.deepEqual(rest, ["next", "prev"]);
  });
  it("送れなければ（端のページなど）残りも捨てる", () => {
    assert.deepEqual(
      sendQueued(["next", "next"], () => false),
      [],
    );
  });
  it("覚えていなければ送らない", () => {
    let called = false;
    assert.deepEqual(
      sendQueued([], () => {
        called = true;
        return true;
      }),
      [],
    );
    assert.equal(called, false);
  });
});

describe("nextSort（見出しを押したあとの並べ替え）", () => {
  it("並べ替えていなければ昇順から、同じ列は 昇順 → 降順 → なし", () => {
    assert.deepEqual(nextSort(undefined, 1), { column: 1, desc: false });
    assert.deepEqual(nextSort({ column: 1, desc: false }, 1), {
      column: 1,
      desc: true,
    });
    assert.equal(nextSort({ column: 1, desc: true }, 1), null);
  });
  it("ほかの列を押すと、その列の昇順になる", () => {
    assert.deepEqual(nextSort({ column: 1, desc: true }, 0), {
      column: 0,
      desc: false,
    });
  });
});

describe("sortable・ariaSort", () => {
  it("包める文で列があるときだけ並べ替えられる", () => {
    assert.equal(sortable(result({ wrappable: true })), true);
    assert.equal(sortable(result({ wrappable: false })), false);
    assert.equal(sortable(result({ wrappable: true, columns: [] })), false);
    assert.equal(sortable(result({})), false);
  });
  it("aria-sort は、並べている列だけに付く", () => {
    const s = { column: 2, desc: true };
    assert.equal(ariaSort(s, 2), "descending");
    assert.equal(ariaSort({ column: 2, desc: false }, 2), "ascending");
    assert.equal(ariaSort(s, 1), undefined);
    assert.equal(ariaSort(undefined, 0), undefined);
  });
});

describe("送る引数と、ページ・並べ替えの続き（#378 の既定のスキーマ）", () => {
  it("入力欄からの実行は、そのときの既定のスキーマを付けて送る（無ければ付けない）", () => {
    assert.deepEqual(pageParams(firstPage("SELECT 1", "app"), 0, false), {
      sql: "SELECT 1",
      schema: "app",
    });
    assert.deepEqual(pageParams(firstPage("SELECT 1"), 0, false), {
      sql: "SELECT 1",
    });
    assert.deepEqual(firstPage("SELECT 1", ""), { sql: "SELECT 1", back: [] });
  });

  it("ページ送りは、最初の実行のスキーマと並べ替えを引き継ぐ", () => {
    const first = firstPage("SELECT * FROM t", "app");
    const r = result({ wrappable: true, truncated: true, rowCount: 1000 });
    const t = pageTarget(r, first, "next")!;
    const next = steppedPage(first, t.back);
    assert.equal(next.schema, "app");
    assert.deepEqual(pageParams(next, t.offset, true), {
      sql: "SELECT * FROM t",
      offset: 1000,
      schema: "app",
      rerun: true,
    });
    const sorted = sortedPage(next, { column: 1, desc: true });
    assert.deepEqual(steppedPage(sorted, [0]), {
      sql: "SELECT * FROM t",
      back: [0],
      sort: { column: 1, desc: true },
      schema: "app",
    });
  });

  it("並べ替えは先頭のページから、スキーマを引き継ぐ。並べ替えをやめると sort が無くなる", () => {
    const page = steppedPage(firstPage("SELECT * FROM t", "app"), [0]);
    const sorted = sortedPage(page, { column: 0, desc: false });
    assert.deepEqual(pageParams(sorted, 0, true), {
      sql: "SELECT * FROM t",
      orderBy: 1,
      schema: "app",
      rerun: true,
    });
    assert.deepEqual(sortedPage(sorted, undefined), {
      sql: "SELECT * FROM t",
      back: [],
      schema: "app",
    });
  });
});
