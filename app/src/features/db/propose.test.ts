import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DbProposeReport,
  DbProposeRequest,
} from "../../infrastructure/rpc/protocol.ts";
import {
  addDb,
  addEmptyWorkspace,
  dbTabsOf,
  EMPTY_GWS,
  type DbRef,
  type GwsState,
  type TabRef,
} from "../workspaces/model.ts";
import {
  isProposeEnter,
  PROPOSE_ENTER_GUARD_MS,
  proposeTab,
  replaceable,
} from "./propose.ts";
import { createDbPropose } from "./proposeController.ts";

const dbTab = (
  id: string,
  target: string,
  connection: string,
  variant?: string,
): DbRef => ({
  kind: "db",
  id,
  target,
  connection,
  ...(variant ? { variant } : {}),
});

describe("kisui db propose の書く先のタブ", () => {
  const tabs: TabRef[] = [
    { kind: "browser", id: "b1" },
    dbTab("d1", "a", "shop", "dev"),
    dbTab("d2", "a", "shop", "prod"),
    dbTab("d3", "a", "shop", "prod"),
    dbTab("d4", "b", "shop", "prod"),
    dbTab("d5", "a", "local"),
  ];

  it("マシン・接続・変種が同じ DB のタブ。変種の無い接続は、変種の無いタブ", () => {
    assert.equal(proposeTab(tabs, undefined, "a", "shop", "dev")?.id, "d1");
    assert.equal(proposeTab(tabs, undefined, "b", "shop", "prod")?.id, "d4");
    assert.equal(proposeTab(tabs, undefined, "a", "local")?.id, "d5");
  });

  it("2 つ以上あれば、今出しているタブ。出していなければ並びの最初", () => {
    assert.equal(proposeTab(tabs, "d3", "a", "shop", "prod")?.id, "d3");
    assert.equal(proposeTab(tabs, "d1", "a", "shop", "prod")?.id, "d2");
    assert.equal(proposeTab(tabs, undefined, "a", "shop", "prod")?.id, "d2");
  });

  it("別のマシン・別の変種・変種の有り無しが違うタブは選ばない", () => {
    assert.equal(proposeTab(tabs, undefined, "c", "shop", "prod"), undefined);
    assert.equal(proposeTab(tabs, undefined, "a", "shop", "stg"), undefined);
    assert.equal(proposeTab(tabs, undefined, "a", "shop"), undefined);
    assert.equal(proposeTab(tabs, undefined, "a", "local", "dev"), undefined);
  });
});

describe("入力欄の SQL を聞かずに替えてよいか", () => {
  it("空・空白だけ・もう同じ SQL なら聞かない。違う SQL があれば聞く", () => {
    assert.equal(replaceable("", "SELECT 1"), true);
    assert.equal(replaceable(" \n\t", "SELECT 1"), true);
    assert.equal(replaceable("SELECT 1", "SELECT 1"), true);
    assert.equal(replaceable("SELECT 2", "SELECT 1"), false);
  });
});

describe("上書きを聞く窓の Enter", () => {
  const ev = (key: string, extra: object = {}) => ({
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...extra,
  });
  const late = PROPOSE_ENTER_GUARD_MS;

  it("修飾キーの無い Enter だけを受ける", () => {
    assert.equal(isProposeEnter(ev("Enter"), late, false), true);
    assert.equal(isProposeEnter(ev("y"), late, false), false);
    assert.equal(isProposeEnter(ev("Escape"), late, false), false);
    for (const mod of ["ctrlKey", "metaKey", "altKey", "shiftKey"])
      assert.equal(
        isProposeEnter(ev("Enter", { [mod]: true }), late, false),
        false,
      );
  });

  it("開いた直後・押しっぱなし・変換の確定・ボタンの上の Enter は受けない", () => {
    assert.equal(isProposeEnter(ev("Enter"), late - 1, false), false);
    assert.equal(
      isProposeEnter(ev("Enter", { repeat: true }), late, false),
      false,
    );
    assert.equal(
      isProposeEnter(ev("Enter", { isComposing: true }), late, false),
      false,
    );
    assert.equal(
      isProposeEnter(ev("Enter", { keyCode: 229 }), late, false),
      false,
    );
    assert.equal(isProposeEnter(ev("Enter"), late, true), false);
  });
});

describe("kisui db propose の頼み", () => {
  const rq = (
    id: string,
    sql: string,
    variant: string | undefined = "prod",
  ): DbProposeRequest => ({
    id,
    connection: "shop",
    sql,
    ...(variant ? { variant } : {}),
  });

  function setup(opts: { current?: string | null } = {}) {
    let gws: GwsState = addEmptyWorkspace(EMPTY_GWS, "", "g1");
    gws = addEmptyWorkspace(gws, "", "g2");
    gws = addDb(gws, "g1", dbTab("d1", "a", "shop", "prod"));
    gws = addDb(gws, "g2", dbTab("d9", "a", "shop", "dev"));
    let current: string | null =
      opts.current === undefined ? "g1" : opts.current;
    const drafts: Record<string, string> = {};
    const toasts: string[] = [];
    let focused = 0;
    let n = 0;
    const p = createDbPropose({
      currentGws: () => gws.list.find((g) => g.id === current),
      setGws: (f) => {
        gws = f(gws);
      },
      shownDbTab: () => undefined,
      refOf: (id) => dbTabsOf(gws).find((r) => r.id === id),
      draftOf: (id) => drafts[id] ?? "",
      setDraft: (id, sql) => {
        drafts[id] = sql;
      },
      labelOf: (t) => `machine ${t}`,
      showToast: (text) => toasts.push(text),
      focusTerminal: () => {
        focused++;
      },
      newId: () => `new${++n}`,
    });
    return {
      p,
      drafts,
      toasts,
      focused: () => focused,
      gws: () => gws,
      setGws: (f: (g: GwsState) => GwsState) => {
        gws = f(gws);
      },
      setCurrent: (id: string | null) => {
        current = id;
      },
    };
  }
  /** 約束が進むのを待つ（聞く窓が出るまで）。 */
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const tabsOf = (s: GwsState, gid: string) =>
    s.list
      .find((g) => g.id === gid)
      ?.tabs.map((r) => (r.kind === "db" ? r.id : ""));

  it("今のワークスペースの同じ接続のタブの、空の入力欄には、聞かずに書く", async () => {
    const t = setup();
    assert.deepEqual(await t.p.propose("a", rq("x1", "SELECT 1")), {
      status: "written",
    });
    assert.deepEqual(t.drafts, { d1: "SELECT 1" });
    assert.equal(t.p.proposeAsk(), null);
    assert.equal(t.toasts.length, 1);
    assert.match(t.toasts[0]!, /shop \(prod\)/);
    assert.match(t.toasts[0]!, /machine a/);
    // タブは増えず、キーの行き先も変えない
    assert.deepEqual(tabsOf(t.gws(), "g1"), ["d1"]);
    assert.equal(t.focused(), 0);
  });

  it("同じ接続のタブが今のワークスペースに無ければ、新しく開いて書く（ほかのワークスペースのタブは使わない）", async () => {
    const t = setup();
    assert.deepEqual(await t.p.propose("a", rq("x1", "SELECT 1", "dev")), {
      status: "written",
    });
    assert.deepEqual(tabsOf(t.gws(), "g1"), ["d1", "new1"]);
    assert.deepEqual(
      dbTabsOf(t.gws()).find((r) => r.id === "new1"),
      dbTab("new1", "a", "shop", "dev"),
    );
    assert.deepEqual(t.drafts, { new1: "SELECT 1" });
    // 別のマシンの同じ名前の接続も、別のタブ。変種の無い接続のタブには variant を付けない
    await t.p.propose("b", rq("x2", "SELECT 2", ""));
    assert.deepEqual(
      dbTabsOf(t.gws()).find((r) => r.id === "new2"),
      dbTab("new2", "b", "shop"),
    );
  });

  it("入力欄に SQL があれば人に聞き、上書きを許されたら書く", async () => {
    const t = setup();
    t.drafts.d1 = "SELECT old";
    const done = t.p.propose("a", rq("x1", "SELECT new"));
    await tick();
    assert.deepEqual(t.p.proposeAsk(), {
      tab: "d1",
      connection: "shop (prod)",
      machine: "machine a",
      current: "SELECT old",
      sql: "SELECT new",
    });
    assert.equal(t.drafts.d1, "SELECT old");
    t.p.replyPropose(true);
    assert.deepEqual(await done, { status: "written" });
    assert.equal(t.drafts.d1, "SELECT new");
    assert.equal(t.p.proposeAsk(), null);
    assert.equal(t.focused(), 1);
  });

  it("人が断ったら、書かずに declined を返す", async () => {
    const t = setup();
    t.drafts.d1 = "SELECT old";
    const done = t.p.propose("a", rq("x1", "SELECT new"));
    await tick();
    t.p.replyPropose(false);
    assert.deepEqual(await done, { status: "declined" });
    assert.equal(t.drafts.d1, "SELECT old");
    assert.deepEqual(t.toasts, []);
    assert.equal(t.p.proposeAsk(), null);
  });

  it("もう同じ SQL が入っていれば、聞かない", async () => {
    const t = setup();
    t.drafts.d1 = "SELECT 1";
    assert.deepEqual(await t.p.propose("a", rq("x1", "SELECT 1")), {
      status: "written",
    });
    assert.equal(t.p.proposeAsk(), null);
  });

  it("頼みは 1 つずつ扱う：前の頼みが書いた SQL を、次の頼みは上書きとして聞く", async () => {
    const t = setup();
    const first = t.p.propose("a", rq("x1", "SELECT 1"));
    const second = t.p.propose("a", rq("x2", "SELECT 2"));
    assert.deepEqual(await first, { status: "written" });
    await tick();
    assert.equal(t.p.proposeAsk()?.current, "SELECT 1");
    assert.equal(t.p.proposeAsk()?.sql, "SELECT 2");
    t.p.replyPropose(true);
    assert.deepEqual(await second, { status: "written" });
    assert.equal(t.drafts.d1, "SELECT 2");
  });

  it("聞いている途中で取り下げられたら、窓を閉じて書かない。次の頼みは続ける", async () => {
    const t = setup();
    t.drafts.d1 = "SELECT old";
    const first = t.p.propose("a", rq("x1", "SELECT 1"));
    const second = t.p.propose("a", rq("x2", "SELECT 2"));
    const third = t.p.propose("a", rq("x3", "SELECT 3"));
    await tick();
    // 別のマシンの同じ id・もう無い id の取り下げは、何もしない
    t.p.cancelPropose("b", "x1");
    t.p.cancelPropose("a", "nope");
    assert.equal(t.p.proposeAsk()?.sql, "SELECT 1");
    // 順番を待っている頼みの取り下げ
    t.p.cancelPropose("a", "x2");
    t.p.cancelPropose("a", "x1");
    assert.ok("error" in ((await first) as DbProposeReport));
    assert.ok("error" in ((await second) as DbProposeReport));
    await tick();
    assert.equal(t.p.proposeAsk()?.sql, "SELECT 3");
    assert.equal(t.drafts.d1, "SELECT old");
    t.p.replyPropose(true);
    assert.deepEqual(await third, { status: "written" });
    assert.equal(t.drafts.d1, "SELECT 3");
    // 済んだ頼みの取り下げは、何もしない
    t.p.cancelPropose("a", "x3");
    assert.equal(t.drafts.d1, "SELECT 3");
  });

  it("聞いている間にタブが閉じられたら、書かずに理由を返す", async () => {
    const t = setup();
    t.drafts.d1 = "SELECT old";
    const done = t.p.propose("a", rq("x1", "SELECT new"));
    await tick();
    t.setGws((s) => ({
      list: s.list.map((g) => ({ ...g, tabs: [] })),
    }));
    t.p.replyPropose(true);
    assert.ok("error" in ((await done) as DbProposeReport));
    assert.equal(t.drafts.d1, "SELECT old");
  });

  it("今のワークスペースが無ければ、理由を返す", async () => {
    const t = setup({ current: null });
    assert.ok("error" in (await t.p.propose("a", rq("x1", "SELECT 1"))));
    assert.deepEqual(t.drafts, {});
  });
});
