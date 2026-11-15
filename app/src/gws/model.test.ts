import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KeyValueStore } from "../ssh/machines.ts";
import {
  addBrowser,
  addWorkspace,
  after,
  autoName,
  browserKey,
  cycleKey,
  displayName,
  dropTerm,
  EMPTY_GWS,
  freeNum,
  GWS_KEY,
  gwsOfBrowser,
  gwsOfTerm,
  loadGws,
  move,
  nameError,
  nameErrorText,
  parseGws,
  reconcile,
  removeBrowser,
  rename,
  renameBrowser,
  repTerm,
  saveGws,
  setActiveTerm,
  termKey,
  toggleFold,
  type Gws,
  type GwsState,
} from "./model.ts";

const term = (target: string, ws: string, title = ws) =>
  ({ kind: "term", target, ws, title }) as const;
const ids = (s: GwsState) => s.list.map((g) => g.id);
const nums = (s: GwsState) => s.list.map((g) => g.num);
const list = (...ws: string[]) => ws.map((id) => ({ id, title: id }));

/** 番号 1・2 の 2 つのワークスペース（g1 は a の w1 と b の w2、g2 は a の w3）。 */
function two(): GwsState {
  let s = addWorkspace(EMPTY_GWS, "a", "w1", "w1", "g1");
  s = {
    list: [{ ...s.list[0], tabs: [...s.list[0].tabs, term("b", "w2")] }],
  };
  return addWorkspace(s, "a", "w3", "w3", "g2");
}

describe("番号の名前", () => {
  it("名前を付けていなければ ws1・ws2…、付ければその名前、空にすれば番号の名前に戻る", () => {
    let s = two();
    assert.deepEqual(s.list.map(displayName), ["ws1", "ws2"]);
    s = rename(s, "g1", "  調査 ");
    assert.equal(displayName(s.list[0]), "調査");
    s = rename(s, "g1", "");
    assert.equal(displayName(s.list[0]), "ws1");
    assert.equal(autoName(7), "ws7");
    assert.equal(rename(s, "g1", ""), s);
    assert.equal(rename(s, "nope", "x"), s);
  });

  it("番号は、作ったときに空いている一番小さい番号。閉じるまで変えない", () => {
    let s = two();
    assert.equal(freeNum(s.list), 3);
    // 1 番を閉じたら、次に作るワークスペースが 1 番になる。2 番は変わらない
    s = reconcile(s, {
      lists: { a: list("w3"), b: list() },
    }).state;
    assert.deepEqual(nums(s), [2]);
    s = addWorkspace(s, "a", "w4");
    assert.deepEqual(nums(s), [2, 1]);
    // 名前を付けても、番号は変わらない
    s = rename(s, "g2", "x");
    assert.deepEqual(nums(s), [2, 1]);
  });

  it("名前に付けられない理由", () => {
    assert.equal(nameError("a".repeat(100)), undefined);
    assert.equal(nameError("a".repeat(101)), "too_long");
    assert.equal(nameError("a\nb"), "control");
    assert.equal(nameError(""), undefined);
  });
});

describe("ワークスペースの操作", () => {
  it("ターミナルのタブがもうどこかにあれば、足さない", () => {
    const s = two();
    assert.equal(addWorkspace(s, "b", "w2"), s);
    assert.equal(gwsOfTerm(s, "b", "w2")?.id, "g1");
    assert.equal(gwsOfTerm(s, "b", "nope"), undefined);
  });

  it("1 つ上・下へ動かす。端では動かさない", () => {
    const s = two();
    assert.deepEqual(ids(move(s, "g1", "down")!), ["g2", "g1"]);
    assert.deepEqual(ids(move(s, "g2", "up")!), ["g2", "g1"]);
    assert.equal(move(s, "g1", "up"), null);
    assert.equal(move(s, "g2", "down"), null);
    assert.equal(move(s, "nope", "up"), null);
  });

  it("最後に使っていたターミナルのタブを覚え、帯が出すタブはフォーカスのタブ、無ければそれ、無ければ最初", () => {
    let s = two();
    const g = () => s.list[0];
    assert.equal(repTerm(g()).ws, "w1");
    assert.equal(repTerm(g(), { target: "b", id: "w2" }).ws, "w2");
    assert.equal(repTerm(g(), { target: "b", id: "other" }).ws, "w1");
    s = setActiveTerm(s, "b", "w2");
    assert.equal(repTerm(g()).ws, "w2");
    assert.equal(setActiveTerm(s, "b", "w2"), s);
    assert.equal(setActiveTerm(s, "zz", "w2"), s);
  });

  it("ブラウザのタブを足す・名前を付ける・外す。畳む", () => {
    let s = two();
    s = addBrowser(s, "g1", "t1");
    s = addBrowser(s, "g1", "t2");
    assert.equal(addBrowser(s, "g2", "t1"), s); // どこかにあれば足さない
    assert.deepEqual(
      s.list[0].tabs.map((r) => r.kind),
      ["term", "term", "browser", "browser"],
    );
    assert.equal(gwsOfBrowser(s, "t2")?.id, "g1");
    s = renameBrowser(s, "t1", " メモ ");
    assert.deepEqual(s.list[0].tabs[2], {
      kind: "browser",
      id: "t1",
      name: "メモ",
    });
    s = renameBrowser(s, "t1", "");
    assert.deepEqual(s.list[0].tabs[2], { kind: "browser", id: "t1" });
    s = removeBrowser(s, "t1");
    assert.equal(gwsOfBrowser(s, "t1"), undefined);
    assert.equal(removeBrowser(s, "t1"), s);
    assert.equal(toggleFold(s, "g1").list[0].folded, true);
    assert.equal(toggleFold(toggleFold(s, "g1"), "g1").list[0].folded, false);
  });

  it("タブを閉じたら次（無ければ前）を出す。ページが自分を閉じたら、開いた元に戻る", () => {
    let s = two();
    s = addBrowser(addBrowser(addBrowser(s, "g1", "a"), "g1", "b"), "g1", "c");
    const g = (): Gws => s.list[0];
    // タブは w1 w2 a b c
    assert.deepEqual(after(g(), browserKey("a")), g().tabs[3]);
    assert.deepEqual(after(g(), browserKey("c")), g().tabs[3]);
    assert.deepEqual(after(g(), termKey("a", "w1")), g().tabs[1]);
    // 開いた元（back）があればそれ。無い・自分自身なら、ふつうに閉じたときと同じ
    assert.deepEqual(after(g(), browserKey("b"), "a"), g().tabs[2]);
    assert.deepEqual(after(g(), browserKey("b"), "gone"), g().tabs[4]);
    assert.deepEqual(after(g(), browserKey("b"), "b"), g().tabs[4]);
  });

  it("o j・o k はターミナルのタブとブラウザのタブを、並びの順に回る", () => {
    let s = addBrowser(two(), "g1", "a");
    const g = (): Gws => s.list[0];
    const k = (r: ReturnType<typeof cycleKey>) =>
      r?.kind === "term" ? r.ws : r?.id;
    assert.equal(k(cycleKey(g(), termKey("a", "w1"), "next")), "w2");
    assert.equal(k(cycleKey(g(), termKey("b", "w2"), "next")), "a");
    assert.equal(k(cycleKey(g(), browserKey("a"), "next")), "w1");
    assert.equal(k(cycleKey(g(), termKey("a", "w1"), "prev")), "a");
    // タブが 1 つなら回らない
    assert.equal(cycleKey(s.list[1], termKey("a", "w3"), "next"), undefined);
    s = EMPTY_GWS;
  });

  it("切れているマシンのタブだけを記録から外す", () => {
    const { state: s, close } = dropTerm(two(), "b", "w2");
    assert.deepEqual(
      s.list[0].tabs.map((r) => r.kind === "term" && r.ws),
      ["w1"],
    );
    assert.deepEqual(close, []);
    assert.equal(dropTerm(s, "b", "w2").state, s);
  });

  it("最後のターミナルのタブを外すと、ワークスペースごと外し、中のブラウザのタブを閉じさせる", () => {
    const s = addBrowser(two(), "g2", "t1");
    const r = dropTerm(s, "a", "w3");
    assert.deepEqual(ids(r.state), ["g1"]);
    assert.deepEqual(r.close, ["t1"]);
  });
});

describe("reconcile", () => {
  it("どこにも入っていないターミナルのタブは、1 つにつき新しいワークスペースを 1 つ作る", () => {
    const { state } = reconcile(EMPTY_GWS, {
      lists: { a: list("w1", "w2"), b: list("w3") },
    });
    assert.deepEqual(
      state.list.map((g) => g.tabs.length),
      [1, 1, 1],
    );
    assert.deepEqual(nums(state), [1, 2, 3]);
    // もう一度合わせても変わらない
    const again = reconcile(state, {
      lists: { a: list("w1", "w2"), b: list("w3") },
    });
    assert.equal(again.state, state);
    assert.deepEqual(again.close, []);
  });

  it("すでに入っているものは、そのワークスペースのまま（別のワークスペースを作らない）。タブの名前は最新にする", () => {
    const s = two();
    const { state } = reconcile(s, {
      lists: {
        a: [
          { id: "w1", title: "新しい名前" },
          { id: "w3", title: "w3" },
        ],
        b: list("w2"),
      },
    });
    assert.deepEqual(ids(state), ["g1", "g2"]);
    assert.equal(
      (state.list[0].tabs[0] as { title: string }).title,
      "新しい名前",
    );
  });

  it("一覧が分かっているマシンで、一覧に無いタブ（閉じたもの）は外す。つながっていない（一覧が分からない）マシンのタブは残す", () => {
    const s = two();
    const { state } = reconcile(s, { lists: { a: list("w1", "w3") } });
    // b は一覧が分からない。w2 は残る
    assert.equal(state.list[0].tabs.length, 2);
    const closed = reconcile(s, { lists: { a: list("w1", "w3"), b: list() } });
    assert.equal(closed.state.list[0].tabs.length, 1);
  });

  it("ターミナルのタブが 1 つも無くなったワークスペースは外し、その中のブラウザのタブは閉じる", () => {
    const s = addBrowser(two(), "g2", "t1");
    const r = reconcile(s, {
      lists: { a: list("w1"), b: list("w2") },
      browser: [{ id: "t1", target: "a", workspace: "w3" }],
    });
    assert.deepEqual(ids(r.state), ["g1"]);
    assert.deepEqual(r.close, ["t1"]);
  });

  it("どこにも入っていないブラウザのタブは、開いたときのターミナルのタブがあるワークスペースに入れる", () => {
    const s = two();
    const r = reconcile(s, {
      lists: { a: list("w1", "w3"), b: list("w2") },
      browser: [
        { id: "t1", target: "b", workspace: "w2" },
        { id: "t2", target: "a", workspace: "w3" },
      ],
    });
    assert.equal(gwsOfBrowser(r.state, "t1")?.id, "g1");
    assert.equal(gwsOfBrowser(r.state, "t2")?.id, "g2");
    assert.deepEqual(r.close, []);
  });

  it("元のターミナルのタブが（一覧が分かっているマシンに）無ければ閉じ、元のマシンの一覧がまだ分からなければ待つ", () => {
    const s = two();
    const r = reconcile(s, {
      lists: { a: list("w1", "w3"), b: list("w2") },
      browser: [
        { id: "gone", target: "a", workspace: "w9" },
        { id: "wait", target: "c", workspace: "w1" },
      ],
    });
    assert.deepEqual(r.close, ["gone"]);
    assert.equal(gwsOfBrowser(r.state, "wait"), undefined);
  });

  it("ブラウザのタブをまだ読んでいない（undefined）あいだは、記録のブラウザのタブを捨てず、足しもしない", () => {
    const s = addBrowser(two(), "g1", "t1");
    const r = reconcile(s, { lists: { a: list("w1", "w3"), b: list("w2") } });
    assert.equal(r.state, s);
    // 読み終えて、タブが無ければ外す
    const r2 = reconcile(s, {
      lists: { a: list("w1", "w3"), b: list("w2") },
      browser: [],
    });
    assert.equal(gwsOfBrowser(r2.state, "t1"), undefined);
  });

  it("並びの記録（前の版）があれば、新しく作るワークスペースをその順に並べる。記録の無いものは一覧の順のまま後ろ", () => {
    const { state } = reconcile(EMPTY_GWS, {
      lists: { a: list("w1", "w2"), b: list("w3") },
      legacyOrder: [
        { target: "b", id: "w3" },
        { target: "a", id: "w2" },
      ],
    });
    assert.deepEqual(
      state.list.map((g) => (g.tabs[0] as { ws: string }).ws),
      ["w3", "w2", "w1"],
    );
  });

  it("同じタブが 2 つのワークスペースにあれば、先のものだけ残す", () => {
    const s: GwsState = {
      list: [
        { id: "g1", name: "", num: 1, tabs: [term("a", "w1")] },
        {
          id: "g2",
          name: "",
          num: 2,
          tabs: [term("a", "w1"), term("a", "w2")],
        },
      ],
    };
    const { state } = reconcile(s, { lists: { a: list("w1", "w2") } });
    assert.deepEqual(
      state.list.map((g) => g.tabs.length),
      [1, 1],
    );
  });
});

describe("記録", () => {
  const mem = (init?: string): KeyValueStore & { v: string | null } => ({
    v: init ?? null,
    getItem() {
      return this.v;
    },
    setItem(_k, value) {
      this.v = value;
    },
  });

  it("書いたものを読める（名前・並び・中のタブ・最後のタブ・畳み）。無い・壊れているときは null", () => {
    let s = addBrowser(two(), "g1", "t1");
    s = renameBrowser(rename(s, "g2", "調査"), "t1", "メモ");
    s = toggleFold(setActiveTerm(s, "b", "w2"), "g1");
    const store = mem();
    saveGws(store, s);
    assert.deepEqual(loadGws(store), s);
    assert.equal(loadGws(mem()), null);
    assert.equal(loadGws(mem("{")), null);
    assert.equal(loadGws(undefined), null);
    assert.equal(typeof GWS_KEY, "string");
  });

  it("保存できなくても例外にしない", () => {
    const bad: KeyValueStore = {
      getItem() {
        throw new Error("x");
      },
      setItem() {
        throw new Error("x");
      },
    };
    saveGws(bad, two());
    assert.equal(loadGws(bad), null);
  });

  it("形の違うもの・重なり・ターミナルのタブが無いワークスペースは捨てる。番号が壊れていれば振り直す", () => {
    const s = parseGws({
      list: [
        { id: "g1", name: "a", num: 1, tabs: [term("a", "w1"), { kind: "x" }] },
        { id: "g1", name: "dup", num: 2, tabs: [term("a", "w2")] },
        {
          id: "g2",
          name: "",
          num: 1,
          tabs: [term("a", "w1"), term("a", "w3")],
        },
        { id: "g3", name: "", num: 3, tabs: [{ kind: "browser", id: "t" }] },
        {
          id: "g4",
          name: 5,
          num: "x",
          tabs: [term("c", "w4")],
          term: { target: "z", ws: "z" },
        },
        "x",
      ],
    });
    assert.deepEqual(ids(s), ["g1", "g2", "g4"]);
    assert.deepEqual(s.list[1].tabs.length, 1); // w1 は g1 にある
    assert.deepEqual(nums(s), [1, 2, 3].slice(0, 1).concat(nums(s).slice(1)));
    assert.equal(new Set(nums(s)).size, 3);
    assert.equal(s.list[2].name, "");
    assert.equal(s.list[2].term, undefined);
    assert.deepEqual(parseGws(null), EMPTY_GWS);
    assert.deepEqual(parseGws({ list: 3 }), EMPTY_GWS);
  });
});

describe("reconcile の keep", () => {
  it("作ったばかりでまだ一覧に無いタブは、keep に入れておけば外さない", () => {
    const s = addWorkspace(two(), "a", "w9", "", "g3");
    const lists = { a: list("w1", "w3"), b: list("w2") };
    assert.equal(reconcile(s, { lists }).state.list.length, 2);
    const kept = reconcile(s, {
      lists,
      keep: new Set([termKey("a", "w9")]),
    });
    assert.equal(kept.state, s);
  });
});

describe("nameErrorText", () => {
  it("付けられる名前なら undefined、付けられなければ理由の文", () => {
    assert.equal(nameErrorText("調査"), undefined);
    assert.ok(nameErrorText("a".repeat(101)));
    assert.ok(nameErrorText("a\nb"));
    assert.notEqual(nameErrorText("a".repeat(101)), nameErrorText("a\nb"));
  });
});
