import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activeRunning,
  activeStatement,
  EMPTY_RUN,
  resultTabLabel,
  runInOrder,
  startStatement,
  stepResult,
  updateStatement,
  type DbRun,
  type StatementOutcome,
} from "./results.ts";

const q = (queryId: string) => ({ queryId, target: "m" });

describe("startStatement", () => {
  it("新しい文を足し、実行している印を付ける", () => {
    const r = startStatement(EMPTY_RUN, 0, "select 1", q("a"));
    assert.deepEqual(r.statements, [{ sql: "select 1" }]);
    assert.equal(r.active, 0);
    assert.deepEqual(r.running, { queryId: "a", target: "m", index: 0 });
    assert.equal(activeRunning(r), true);
  });

  it("出している結果は、実行している文に付いていく", () => {
    let r = startStatement(EMPTY_RUN, 0, "select 1", q("a"));
    r = startStatement(r, 1, "select 2", q("b"));
    assert.equal(r.active, 1);
    assert.equal(r.statements.length, 2);
  });

  it("前の文の結果に切り替えていたら、付いていかない", () => {
    let r = startStatement(EMPTY_RUN, 0, "select 1", q("a"));
    r = startStatement(r, 1, "select 2", q("b"));
    r = { ...r, active: 0 };
    r = startStatement(r, 2, "select 3", q("c"));
    assert.equal(r.active, 0);
    assert.equal(activeRunning(r), false);
    assert.equal(r.running?.index, 2);
  });

  it("ある文（ページ送り・並べ替え）なら、足さずに印だけ付ける", () => {
    let r: DbRun = {
      statements: [{ sql: "select 1" }, { sql: "select 2" }],
      active: 0,
    };
    r = startStatement(r, 0, "select 1", q("p"));
    assert.equal(r.statements.length, 2);
    assert.equal(r.active, 0);
    assert.equal(r.running?.index, 0);
  });
});

describe("updateStatement", () => {
  it("その文だけを替える", () => {
    const r: DbRun = {
      statements: [{ sql: "a" }, { sql: "b" }],
      active: 1,
    };
    const next = updateStatement(r, 1, (s) => ({
      ...s,
      failure: { kind: "cancelled" },
    }));
    assert.deepEqual(next.statements, [
      { sql: "a" },
      { sql: "b", failure: { kind: "cancelled" } },
    ]);
    assert.equal(activeStatement(next)?.failure?.kind, "cancelled");
  });

  it("無い文なら、そのまま", () => {
    assert.equal(
      updateStatement(EMPTY_RUN, 0, (s) => s),
      EMPTY_RUN,
    );
  });
});

describe("stepResult", () => {
  const r: DbRun = {
    statements: [{ sql: "a" }, { sql: "b" }, { sql: "c" }],
    active: 1,
  };
  it("前・次へ動く", () => {
    assert.equal(stepResult(r, 1), 2);
    assert.equal(stepResult(r, -1), 0);
  });
  it("端では動かない", () => {
    assert.equal(stepResult({ ...r, active: 2 }, 1), 2);
    assert.equal(stepResult({ ...r, active: 0 }, -1), 0);
    assert.equal(stepResult(EMPTY_RUN, 1), 0);
  });
});

describe("resultTabLabel", () => {
  it("改行と空白を詰めて 1 行に", () => {
    assert.equal(resultTabLabel("select\n  1"), "select 1");
  });
  it("長ければ切って …", () => {
    assert.equal(resultTabLabel("select * from users", 8), "select *…");
    assert.equal(resultTabLabel("select 1", 8), "select 1");
  });
  it("前にあるコメントを除く", () => {
    assert.equal(resultTabLabel("-- users\nselect 1"), "select 1");
    assert.equal(resultTabLabel("/* a */ /* b */\nselect 2"), "select 2");
    assert.equal(resultTabLabel("# my\nselect 3"), "select 3");
  });
  it("コメントだけなら、そのまま詰めた字", () => {
    assert.equal(resultTabLabel("-- only"), "-- only");
  });
  it("字数はコードポイントで数える", () => {
    assert.equal(resultTabLabel("select '日本語'", 9), "select '日…");
  });
});

describe("runInOrder（文を上から順に実行して、止める）", () => {
  /** 文ごとの結果を outcomes で返す偽の runOne。呼ばれた文と more を calls に残す */
  function fake(outcomes: StatementOutcome[]) {
    const calls: [number, string, boolean][] = [];
    const runOne = async (i: number, sql: string, more: boolean) => {
      calls.push([i, sql, more]);
      return outcomes[i] ?? "ok";
    };
    return { calls, runOne };
  }
  const sqls = ["select 1", "select 2", "select 3"];

  it("全部 ok なら、上から順に全部送って done", async () => {
    const f = fake([]);
    assert.equal(await runInOrder(sqls, f.runOne, () => false), "done");
    assert.deepEqual(f.calls, [
      [0, "select 1", true],
      [1, "select 2", true],
      [2, "select 3", false],
    ]);
  });

  it("2 つ目が failed なら、3 つ目を送らない", async () => {
    const f = fake(["ok", "failed", "ok"]);
    assert.equal(await runInOrder(sqls, f.runOne, () => false), "failed");
    assert.deepEqual(
      f.calls.map((c) => c[0]),
      [0, 1],
    );
  });

  it("gone で止まる", async () => {
    const f = fake(["gone"]);
    assert.equal(await runInOrder(sqls, f.runOne, () => false), "gone");
    assert.equal(f.calls.length, 1);
  });

  it("1 つ目の後に取り消していたら、2 つ目を送らない", async () => {
    const f = fake([]);
    assert.equal(await runInOrder(sqls, f.runOne, () => true), "stopped");
    assert.equal(f.calls.length, 1);
  });

  it("最後の文の後では、取り消しを見ない", async () => {
    const f = fake([]);
    let asked = 0;
    const stop = () => (asked++, f.calls.length >= 3);
    assert.equal(await runInOrder(sqls, f.runOne, stop), "done");
    assert.equal(asked, 2);
  });
});
