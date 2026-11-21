import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activeRunning,
  activeTab,
  closeTab,
  EMPTY_RUN,
  MAX_RESULT_TABS,
  restartTab,
  resultTabLabel,
  runInOrder,
  startStatement,
  stepTab,
  updateTab,
  type DbRun,
  type RunInto,
  type StatementOutcome,
} from "./results.ts";

const q = (queryId: string) => ({ queryId, target: "m" });
const ids = (r: DbRun) => r.tabs.map((t) => t.id);

/** r で、1 つ目の文 sql を into の先に実行し始める（新しいタブの名前は newId）。 */
function first(r: DbRun, newId: string, sql: string, into: RunInto = "active") {
  return startStatement(r, { sql, running: q(`q-${newId}`), newId, into });
}
/** r で、2 つ目からの文 sql を実行し始める（1 つ前の文のタブは prev）。 */
function next(r: DbRun, newId: string, sql: string, prev: string) {
  return startStatement(r, {
    sql,
    running: q(`q-${newId}`),
    newId,
    into: "active",
    prev,
  });
}
/** 結果のあるタブ a・b・c を持ち、b を出している状態。 */
const three: DbRun = {
  tabs: [
    { id: "a", sql: "select 1" },
    { id: "b", sql: "select 2", page: { sql: "select 2", back: [0] } },
    { id: "c", sql: "select 3" },
  ],
  active: "b",
};

describe("startStatement（1 つ目の文）", () => {
  it("タブが無ければ、足して出す", () => {
    const { run, tab } = first(EMPTY_RUN, "r1", "select 1");
    assert.equal(tab, "r1");
    assert.deepEqual(run.tabs, [{ id: "r1", sql: "select 1" }]);
    assert.equal(run.active, "r1");
    assert.deepEqual(run.running, { queryId: "q-r1", target: "m", tab: "r1" });
    assert.equal(activeRunning(run), true);
  });

  it("ふつうの実行は、出しているタブに上書きする（タブは増えない。前の結果・ページは捨てる）", () => {
    const { run, tab } = first(three, "r9", "select 2 where id = 3");
    assert.equal(tab, "b");
    assert.deepEqual(ids(run), ["a", "b", "c"]);
    assert.deepEqual(run.tabs[1], { id: "b", sql: "select 2 where id = 3" });
    assert.equal(run.active, "b");
    assert.equal(run.running?.tab, "b");
    // ほかのタブはそのまま
    assert.equal(run.tabs[0], three.tabs[0]);
    assert.equal(run.tabs[2], three.tabs[2]);
  });

  it("新しいタブへの実行は、出しているタブの右隣に足して、それを出す", () => {
    const { run, tab } = first(three, "r9", "select 9", "new");
    assert.equal(tab, "r9");
    assert.deepEqual(ids(run), ["a", "b", "r9", "c"]);
    assert.equal(run.active, "r9");
    assert.equal(run.running?.tab, "r9");
    // 出していたタブの結果・ページは残る
    assert.equal(run.tabs[1], three.tabs[1]);
  });
});

describe("startStatement（2 つ目からの文）", () => {
  it("1 つ前の文のタブの右隣に足し、出しているタブは付いていく", () => {
    const a = first(three, "r1", "s1");
    const b = next(a.run, "r2", "s2", a.tab);
    const c = next(b.run, "r3", "s3", b.tab);
    assert.deepEqual(ids(c.run), ["a", "b", "r2", "r3", "c"]);
    assert.equal(c.run.active, "r3");
    assert.equal(c.run.running?.tab, "r3");
    // 1 つ目の文は、出していたタブに上書きした
    assert.equal(c.run.tabs[1]?.sql, "s1");
  });

  it("新しいタブへの実行でも、文の順に並ぶ", () => {
    const a = first(three, "r1", "s1", "new");
    const b = next(a.run, "r2", "s2", a.tab);
    assert.deepEqual(ids(b.run), ["a", "b", "r1", "r2", "c"]);
    assert.equal(b.run.tabs[1], three.tabs[1]);
  });

  it("ほかのタブに切り替えていたら、付いていかない", () => {
    const a = first(three, "r1", "s1");
    const b = next({ ...a.run, active: "a" }, "r2", "s2", a.tab);
    assert.equal(b.run.active, "a");
    assert.equal(activeRunning(b.run), false);
    assert.equal(b.run.running?.tab, "r2");
  });

  it("1 つ前の文のタブが無くなっていたら、列の後ろに足す", () => {
    const b = next(three, "r2", "s2", "gone");
    assert.deepEqual(ids(b.run), ["a", "b", "c", "r2"]);
    assert.equal(b.run.active, "b");
  });
});

describe("startStatement（タブの数の上限）", () => {
  const full: DbRun = {
    tabs: Array.from({ length: MAX_RESULT_TABS }, (_, i) => ({
      id: `t${i}`,
      sql: `select ${i}`,
    })),
    active: "t5",
  };

  it("上限を超えたら、左から閉じる", () => {
    const { run } = first(full, "new", "select 99", "new");
    assert.equal(run.tabs.length, MAX_RESULT_TABS);
    assert.equal(run.tabs[0]?.id, "t1");
    assert.equal(run.active, "new");
  });

  it("出しているタブと、足したタブは閉じない", () => {
    // 2 つ目の文を、出しているタブ（左端）とは別のタブの隣に足す
    const { run } = next({ ...full, active: "t0" }, "new", "s", "t3");
    assert.equal(run.tabs.length, MAX_RESULT_TABS);
    assert.deepEqual(ids(run).slice(0, 4), ["t0", "t2", "t3", "new"]);
    assert.equal(run.active, "t0");
  });

  it("上書きでは増えないので、閉じない", () => {
    const { run } = first(full, "new", "select 99");
    assert.deepEqual(ids(run), ids(full));
  });
});

describe("restartTab（ページ送り・並べ替えの読み直し）", () => {
  it("前の結果を残したまま、実行している印だけ付ける", () => {
    const r = restartTab(three, "b", q("p"));
    assert.deepEqual(r?.tabs, three.tabs);
    assert.equal(r?.active, "b");
    assert.deepEqual(r?.running, { queryId: "p", target: "m", tab: "b" });
  });
  it("無いタブなら undefined", () => {
    assert.equal(restartTab(three, "x", q("p")), undefined);
  });
});

describe("updateTab", () => {
  it("そのタブだけを替える", () => {
    const r = updateTab(three, "b", (t) => ({
      ...t,
      failure: { kind: "cancelled" },
    }));
    assert.equal(r.tabs[0], three.tabs[0]);
    assert.equal(activeTab(r)?.failure?.kind, "cancelled");
    // ページ（と並べ替え）は、タブごとに残る
    assert.deepEqual(activeTab(r)?.page, { sql: "select 2", back: [0] });
  });
  it("無いタブなら、そのまま", () => {
    assert.equal(
      updateTab(three, "x", (t) => t),
      three,
    );
  });
});

describe("closeTab", () => {
  it("出していないタブを閉じても、出しているタブは変わらない", () => {
    const r = closeTab(three, "a");
    assert.deepEqual(ids(r), ["b", "c"]);
    assert.equal(r.active, "b");
  });
  it("出しているタブを閉じたら、右隣を出す。右が無ければ左隣", () => {
    const r = closeTab(three, "b");
    assert.deepEqual(ids(r), ["a", "c"]);
    assert.equal(r.active, "c");
    assert.equal(closeTab(r, "c").active, "a");
  });
  it("最後のタブを閉じたら、まだ実行していない状態に戻る", () => {
    const r = closeTab({ tabs: [{ id: "a", sql: "s" }], active: "a" }, "a");
    assert.deepEqual(r, EMPTY_RUN);
    assert.equal(activeTab(r), undefined);
  });
  it("実行しているタブを閉じたら、実行中の印も外す。ほかのタブなら残す", () => {
    const running = { ...three, running: { ...q("x"), tab: "c" } };
    assert.equal(closeTab(running, "c").running, undefined);
    assert.deepEqual(closeTab(running, "a").running, running.running);
  });
  it("無いタブなら、そのまま", () => {
    assert.equal(closeTab(three, "x"), three);
  });
});

describe("stepTab", () => {
  it("前・次へ動く", () => {
    assert.equal(stepTab(three, 1), "c");
    assert.equal(stepTab(three, -1), "a");
  });
  it("端では動かない", () => {
    assert.equal(stepTab({ ...three, active: "c" }, 1), "c");
    assert.equal(stepTab({ ...three, active: "a" }, -1), "a");
    assert.equal(stepTab(EMPTY_RUN, 1), undefined);
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
