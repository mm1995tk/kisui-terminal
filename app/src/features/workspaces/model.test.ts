import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { moveView, type TabsState } from "../browser/tabs.ts";
import type { KeyValueStore } from "../keyValueStore.ts";
import {
  addBrowser,
  addBrowserWorkspace,
  addDb,
  addEmptyWorkspace,
  addTerm,
  addWorkspace,
  shownBrowserId,
  after,
  autoName,
  browserKey,
  browserOriginOf,
  cycleKey,
  dbKey,
  dbLabel,
  dbRefLabel,
  dbRefParams,
  dbTabsOf,
  displayName,
  dropTerm,
  EMPTY_GWS,
  freeNum,
  GWS_KEY,
  gwsOfBrowser,
  gwsOfDb,
  gwsByName,
  gwsOfTerm,
  hiddenGws,
  loadGws,
  move,
  moveBefore,
  moveTabBefore,
  moveTabStep,
  moveTabTo,
  shownTabKey,
  gwsOfTab,
  steppableTabs,
  visibleTabs,
  refKey,
  nameError,
  nameErrorText,
  newDbTabId,
  parseGws,
  reconcile,
  removeBrowser,
  removeDb,
  removeGws,
  rename,
  renameBrowser,
  renamePage,
  repTerm,
  saveGws,
  setActiveTerm,
  shownDb,
  shownPage,
  termKey,
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
    // 1 番のタブが全部閉じても、1 番は空のまま残る（#307）
    s = reconcile(s, {
      lists: { a: list("w3"), b: list() },
    }).state;
    assert.deepEqual(nums(s), [1, 2]);
    assert.deepEqual(s.list[0].tabs, []);
    // 1 番を閉じたら、次に作るワークスペースが 1 番になる。2 番は変わらない
    s = removeGws(s, "g1");
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
  it("ターミナルのタブを、ワークスペースの一番後ろに足して、最後に使ったタブにする", () => {
    const s = addTerm(two(), "g2", "b", "w9", "新");
    assert.deepEqual(s.list[1].tabs, [term("a", "w3"), term("b", "w9", "新")]);
    assert.deepEqual(s.list[1].term, { target: "b", ws: "w9" });
    assert.equal(addTerm(s, "g2", "b", "w9"), s); // もう入っている
    assert.equal(addTerm(s, "nope", "b", "w8"), s);
  });

  it("activate が false なら、最後に使っていたタブを変えない（ほかにターミナルのタブが無ければ、足したタブ。kisui pane open）", () => {
    const s = addTerm(two(), "g2", "b", "w9", "", false);
    assert.deepEqual(s.list[1].tabs, [term("a", "w3"), term("b", "w9", "")]);
    assert.deepEqual(s.list[1].term, { target: "a", ws: "w3" });
    const e = addTerm(
      addEmptyWorkspace(two(), "", "g3"),
      "g3",
      "b",
      "w9",
      "",
      false,
    );
    assert.deepEqual(e.list[2].term, { target: "b", ws: "w9" });
  });

  it("画面に出す名前でワークスペースを探す（kisui pane open --workspace）", () => {
    let s = rename(two(), "g1", "review");
    assert.deepEqual(
      gwsByName(s, " review ").map((g) => g.id),
      ["g1"],
    );
    assert.deepEqual(
      gwsByName(s, "ws2").map((g) => g.id),
      ["g2"],
    );
    assert.deepEqual(gwsByName(s, "ws1"), []);
    assert.deepEqual(gwsByName(s, ""), []);
    s = rename(s, "g2", "review");
    assert.deepEqual(
      gwsByName(s, "review").map((g) => g.id),
      ["g1", "g2"],
    );
  });

  it("作った直後に別のワークスペースとして入っていたら、そこから移す（空になれば並びから外す）", () => {
    const s = addTerm(
      addWorkspace(two(), "b", "w9", "w9", "g3"),
      "g1",
      "b",
      "w9",
    );
    assert.deepEqual(ids(s), ["g1", "g2"]);
    assert.equal(gwsOfTerm(s, "b", "w9")?.id, "g1");
  });

  it("知らせが返事より先に届く順（孤児として入る → 移す → 一覧から消える → 整理）で、閉じたタブの行が残らない", () => {
    // 知らせが先：整理は印なしで走り、新しいタブが別のワークスペースとして入る
    const lists = { b: [...list("w2"), { id: "w9", title: "新" }] };
    let s = reconcile(two(), { lists, keep: new Set() }).state;
    const orphan = gwsOfTerm(s, "b", "w9");
    assert.ok(orphan && !["g1", "g2"].includes(orphan.id));
    // 返事：addTerm が元のワークスペースへ移す。名前は引き継ぐ
    s = addTerm(s, "g1", "b", "w9");
    assert.deepEqual(ids(s), ["g1", "g2"]);
    assert.deepEqual(s.list[0].tabs.at(-1), term("b", "w9", "新"));
    // 閉じた知らせ：印を付けていなければ、行は消える
    s = reconcile(s, { lists: { b: list("w2") }, keep: new Set() }).state;
    assert.equal(gwsOfTerm(s, "b", "w9"), undefined);
    assert.deepEqual(ids(s), ["g1", "g2"]);
  });

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
    assert.equal(repTerm(g())?.ws, "w1");
    assert.equal(repTerm(g(), { target: "b", id: "w2" })?.ws, "w2");
    assert.equal(repTerm(g(), { target: "b", id: "other" })?.ws, "w1");
    s = setActiveTerm(s, "b", "w2");
    assert.equal(repTerm(g())?.ws, "w2");
    // 最後に使ったタブのマシンが切れていれば、つながっているマシンのタブにする。どれも切れていればそのまま
    assert.equal(repTerm(g(), null, (t) => t === "a")?.ws, "w1");
    assert.equal(repTerm(g(), null, () => false)?.ws, "w2");
    assert.equal(
      repTerm(g(), { target: "b", id: "w2" }, () => false)?.ws,
      "w2",
    );
    assert.equal(setActiveTerm(s, "b", "w2"), s);
    assert.equal(setActiveTerm(s, "zz", "w2"), s);
  });

  it("ブラウザのタブを足す・名前を付ける・外す", () => {
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

  it("cycleKey は、ターミナルのタブとブラウザのタブを並びの順に回る", () => {
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
    const s = dropTerm(two(), "b", "w2");
    assert.deepEqual(
      s.list[0].tabs.map((r) => r.kind === "term" && r.ws),
      ["w1"],
    );
    assert.equal(dropTerm(s, "b", "w2"), s);
  });

  it("最後のタブ（ターミナルのタブ）を外しても、ワークスペースは空のまま残る（#307）", () => {
    const s = setActiveTerm(two(), "a", "w3");
    const r = dropTerm(s, "a", "w3");
    assert.deepEqual(ids(r), ["g1", "g2"]);
    assert.deepEqual(r.list[1].tabs, []);
    assert.equal(r.list[1].num, 2);
    // 最後に使っていたターミナルのタブの覚えは消す（隣のターミナルのタブが無い）
    assert.equal(r.list[1].term, undefined);
    assert.equal(repTerm(r.list[1]), undefined);
  });

  it("removeGws：ワークスペースを並びから外す（空のワークスペースも。#307）。無い id なら、そのまま", () => {
    const s = dropTerm(two(), "a", "w3");
    assert.deepEqual(ids(removeGws(s, "g2")), ["g1"]);
    assert.deepEqual(ids(removeGws(s, "g1")), ["g2"]);
    assert.equal(removeGws(s, "nope"), s);
  });

  it("最後に使っていたターミナルのタブを外すと、その隣（後ろ、無ければ前）のターミナルのタブを最後に使ったものにする", () => {
    // g1 は a の w1・b の w2・a の w4（間にブラウザのタブ）
    let s = addBrowser(two(), "g1", "t1");
    s = addTerm(s, "g1", "a", "w4");
    s = setActiveTerm(s, "b", "w2");
    let r = dropTerm(s, "b", "w2");
    assert.deepEqual(r.list[0].term, { target: "a", ws: "w4" });
    r = dropTerm(r, "a", "w4");
    assert.deepEqual(r.list[0].term, { target: "a", ws: "w1" });
    // 一覧から消えた（reconcile）ときも同じ
    const rc = reconcile(s, {
      lists: { a: list("w1", "w3", "w4"), b: list() },
    }).state;
    assert.deepEqual(rc.list[0].term, { target: "a", ws: "w4" });
    // 最後に使っていたのでないタブを外しても、変えない
    assert.deepEqual(dropTerm(s, "a", "w1").list[0].term, {
      target: "b",
      ws: "w2",
    });
  });

  it("最後のターミナルのタブを外しても、ブラウザのタブがあれば、ワークスペースは残る（#257）", () => {
    const s = addBrowser(two(), "g2", "t1");
    const r = dropTerm(s, "a", "w3");
    assert.deepEqual(ids(r), ["g1", "g2"]);
    assert.deepEqual(r.list[1].tabs, [{ kind: "browser", id: "t1" }]);
    assert.equal(r.list[1].term, undefined);
    assert.equal(repTerm(r.list[1]), undefined);
  });

  it("shownBrowserId：ターミナルのタブがあれば出しているブラウザのタブだけ。無ければ、出しているもの、なければ最初のブラウザのタブ（#257）", () => {
    const all = () => true;
    const withTerm = addBrowser(two(), "g1", "t1").list[0];
    assert.equal(shownBrowserId(withTerm, undefined, all), undefined);
    assert.equal(shownBrowserId(withTerm, "t1", all), "t1");
    assert.equal(
      shownBrowserId(withTerm, "t1", () => false),
      undefined,
    );
    let s = addBrowserWorkspace(two(), "a", "g9");
    s = addBrowser(s, "g9", "b");
    const only = s.list[2];
    assert.equal(shownBrowserId(only, undefined, all), "a");
    assert.equal(shownBrowserId(only, "b", all), "b");
    // 出しているタブが無くなっていれば、残っている最初のもの。他のワークスペースのタブは出さない
    assert.equal(
      shownBrowserId(only, "a", (id) => id === "b"),
      "b",
    );
    assert.equal(shownBrowserId(only, "t1", all), "a");
    assert.equal(
      shownBrowserId(only, undefined, () => false),
      undefined,
    );
  });

  it("ブラウザのタブだけのワークスペースを足せる（#257）。最後のブラウザのタブを外しても、空のまま残る（#307）", () => {
    let s = addBrowserWorkspace(two(), "t1", "g9");
    assert.deepEqual(ids(s), ["g1", "g2", "g9"]);
    assert.equal(s.list[2].num, 3);
    assert.equal(gwsOfBrowser(s, "t1")?.id, "g9");
    assert.equal(addBrowserWorkspace(s, "t1"), s);
    s = addBrowser(s, "g9", "t2");
    s = removeBrowser(s, "t1");
    assert.deepEqual(ids(s), ["g1", "g2", "g9"]);
    s = removeBrowser(s, "t2");
    assert.deepEqual(ids(s), ["g1", "g2", "g9"]);
    assert.deepEqual(s.list[2].tabs, []);
  });

  it("addTerm：作ったばかりのタブのために整理が作ったワークスペースは、タブを移すと外す（空のワークスペースとして残さない）", () => {
    // 一覧の知らせが返事より先に届き、w9 が新しいワークスペース g3 に入ってしまった
    let s = addWorkspace(two(), "a", "w9", "w9", "g3");
    s = addTerm(s, "g1", "a", "w9");
    assert.deepEqual(ids(s), ["g1", "g2"]);
    // ユーザーの空のワークスペースは、ほかのワークスペースにタブを足しても残る
    s = dropTerm(s, "a", "w3");
    s = addTerm(s, "g1", "a", "w10");
    assert.deepEqual(ids(s), ["g1", "g2"]);
    assert.deepEqual(s.list[1].tabs, []);
  });
});

describe("ドラッグでの並べ替え", () => {
  const three = (): GwsState => addWorkspace(two(), "b", "w9", "w9", "g3"); // g1, g2, g3

  it("ワークスペースを、落とした先の帯の前へ動かす（null なら一番後ろ）", () => {
    assert.deepEqual(ids(moveBefore(three(), "g3", "g1")!), ["g3", "g1", "g2"]);
    assert.deepEqual(ids(moveBefore(three(), "g1", "g3")!), ["g2", "g1", "g3"]);
    assert.deepEqual(ids(moveBefore(three(), "g1", null)!), ["g2", "g3", "g1"]);
  });

  it("ワークスペースが動かないとき（今の場所・自分の前・id が無い）は null", () => {
    assert.equal(moveBefore(three(), "g1", "g2"), null);
    assert.equal(moveBefore(three(), "g3", null), null);
    assert.equal(moveBefore(three(), "g2", "g2"), null);
    assert.equal(moveBefore(three(), "nope", "g1"), null);
  });

  it("タブを、同じワークスペースの中で動かす", () => {
    const s = addTerm(two(), "g1", "b", "w5", "x"); // g1: w1, w2, w5
    const k = (w: string, t = "b") => termKey(t, w);
    const a = moveTabBefore(s, "g1", k("w5"), termKey("a", "w1"))!;
    assert.deepEqual(
      a.list[0].tabs.map((r) => (r.kind === "term" ? r.ws : "")),
      ["w5", "w1", "w2"],
    );
    const z = moveTabBefore(s, "g1", termKey("a", "w1"), null)!;
    assert.deepEqual(
      z.list[0].tabs.map((r) => (r.kind === "term" ? r.ws : "")),
      ["w2", "w5", "w1"],
    );
    assert.equal(z.list[1], s.list[1]); // 他のワークスペースはそのまま
  });

  it("タブは別のワークスペースへ移さない（落とし先が別のワークスペースのタブなら、一番後ろ）", () => {
    const s = two();
    const z = moveTabBefore(s, "g1", termKey("a", "w1"), termKey("a", "w3"))!;
    assert.deepEqual(
      z.list[0].tabs.map((r) => (r.kind === "term" ? r.ws : "")),
      ["w2", "w1"],
    );
    assert.deepEqual(z.list[1], s.list[1]);
  });

  it("タブが動かないとき（今の場所・id やキーが無い）は null", () => {
    const s = two();
    assert.equal(
      moveTabBefore(s, "g1", termKey("a", "w1"), termKey("b", "w2")),
      null,
    );
    assert.equal(moveTabBefore(s, "g1", termKey("b", "w2"), null), null);
    assert.equal(moveTabBefore(s, "nope", termKey("a", "w1"), null), null);
    assert.equal(moveTabBefore(s, "g1", termKey("a", "zz"), null), null);
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

  it("ターミナルのタブが 1 つも無くなったワークスペースは、ブラウザのタブがあれば残し（#257）、タブが 1 つも無くなっても残す（#307）", () => {
    const s = addBrowser(two(), "g2", "t1");
    const r = reconcile(s, {
      lists: { a: list("w1"), b: list("w2") },
      browser: [{ id: "t1", target: "a", workspace: "w3" }],
    });
    assert.deepEqual(ids(r.state), ["g1", "g2"]);
    assert.deepEqual(r.state.list[1].tabs, [{ kind: "browser", id: "t1" }]);
    assert.deepEqual(r.close, []);
    // ブラウザのタブも無くなれば、空のワークスペースになる（並びの場所・名前・番号は変わらない）
    const named = rename(r.state, "g2", "調査");
    const r2 = reconcile(named, {
      lists: { a: list("w1"), b: list("w2") },
      browser: [],
    });
    assert.deepEqual(ids(r2.state), ["g1", "g2"]);
    assert.deepEqual(r2.state.list[1].tabs, []);
    assert.equal(displayName(r2.state.list[1]), "調査");
    assert.equal(r2.state.list[1].num, 2);
    // 空のワークスペースは、もう一度合わせても変わらない
    const r3 = reconcile(r2.state, {
      lists: { a: list("w1"), b: list("w2") },
      browser: [],
    });
    assert.equal(r3.state, r2.state);
  });

  it("ターミナルのタブから開いたのではないブラウザのタブ（workspace が空）がどこにも無ければ、新しいワークスペースを作る（#257）", () => {
    const r = reconcile(two(), {
      lists: { a: list("w1", "w3"), b: list("w2") },
      browser: [{ id: "t1", target: "a", workspace: "" }],
    });
    assert.deepEqual(ids(r.state).length, 3);
    assert.deepEqual(r.state.list[2].tabs, [{ kind: "browser", id: "t1" }]);
    assert.deepEqual(r.close, []);
    // もう入っていれば、足さない
    const again = reconcile(r.state, {
      lists: { a: list("w1", "w3"), b: list("w2") },
      browser: [{ id: "t1", target: "a", workspace: "" }],
    });
    assert.equal(again.state, r.state);
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

  it("書いたものを読める（名前・並び・中のタブ・最後のタブ）。無い・壊れているときは null", () => {
    let s = addBrowser(two(), "g1", "t1");
    s = renameBrowser(rename(s, "g2", "調査"), "t1", "メモ");
    s = setActiveTerm(s, "b", "w2");
    const store = mem();
    saveGws(store, s);
    assert.deepEqual(loadGws(store), s);
    assert.equal(loadGws(mem()), null);
    assert.equal(loadGws(mem("{")), null);
    assert.equal(loadGws(undefined), null);
    assert.equal(typeof GWS_KEY, "string");
  });

  it("空のワークスペースも、名前・id・番号・並び順のまま読める（#307）。閉じたものは読んでも戻らない", () => {
    let s = rename(dropTerm(two(), "a", "w3"), "g2", "調査");
    s = moveBefore(s, "g2", "g1")!;
    const store = mem();
    saveGws(store, s);
    const loaded = loadGws(store)!;
    assert.deepEqual(loaded, s);
    assert.deepEqual(ids(loaded), ["g2", "g1"]);
    assert.deepEqual(loaded.list[0].tabs, []);
    saveGws(store, removeGws(loaded, "g2"));
    assert.deepEqual(ids(loadGws(store)!), ["g1"]);
  });

  it("前の版が書いた folded（タブの並びを畳む印）は読み捨てる（#283）", () => {
    const s = two();
    const store = mem();
    saveGws(store, s);
    const raw = JSON.parse(store.v!);
    raw.list[0].folded = true;
    const loaded = loadGws(mem(JSON.stringify(raw)));
    assert.deepEqual(loaded, s);
    assert.equal("folded" in loaded!.list[0], false);
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

  it("形の違うもの・重なりは捨てる。ブラウザのタブだけのもの・タブが 1 つも無いもの（#307）は残す。番号が壊れていれば振り直す", () => {
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
        { id: "g5", name: "", num: 6, tabs: [{ kind: "x" }] },
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
    assert.deepEqual(ids(s), ["g1", "g2", "g3", "g5", "g4"]);
    assert.deepEqual(s.list[1].tabs.length, 1); // w1 は g1 にある
    assert.deepEqual(s.list[3].tabs, []); // 形の違うタブだけを捨てて、空のワークスペースとして残る
    assert.equal(s.list[3].num, 6);
    assert.equal(new Set(nums(s)).size, 5);
    assert.equal(s.list[4].name, "");
    assert.equal(s.list[4].term, undefined);
    assert.deepEqual(parseGws(null), EMPTY_GWS);
    assert.deepEqual(parseGws({ list: 3 }), EMPTY_GWS);
  });
});

describe("reconcile の keep", () => {
  it("作ったばかりでまだ一覧に無いタブは、keep に入れておけば外さない", () => {
    const s = addWorkspace(two(), "a", "w9", "", "g3");
    const lists = { a: list("w1", "w3"), b: list("w2") };
    assert.deepEqual(reconcile(s, { lists }).state.list[2].tabs, []);
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

describe("moveTabTo（タブを別のワークスペースへ移す。#308）", () => {
  const keys = (s: GwsState, id: string) =>
    s.list.find((g) => g.id === id)!.tabs.map(refKey);
  /** g1 は a の w1・b の w2・ブラウザの t1、g2 は a の w3、g3 は空。 */
  function three(): GwsState {
    const s = addBrowser(two(), "g1", "t1");
    return {
      list: [...s.list, { id: "g3", name: "", num: 3, tabs: [] }],
    };
  }

  it("ターミナルのタブを、別のワークスペースの一番後ろへ移す。タブそのもの（マシン・ワークスペース・名前）は変わらない", () => {
    const s = three();
    const ref = s.list[0].tabs[1];
    const z = moveTabTo(s, termKey("b", "w2"), "g2", null)!;
    assert.deepEqual(keys(z, "g1"), [termKey("a", "w1"), browserKey("t1")]);
    assert.deepEqual(keys(z, "g2"), [termKey("a", "w3"), termKey("b", "w2")]);
    assert.equal(z.list[1].tabs[1], ref);
    assert.equal(gwsOfTab(z, termKey("b", "w2"))?.id, "g2");
    // どのタブも、どこか 1 つのワークスペースにだけある
    const all = z.list.flatMap((g) => g.tabs.map(refKey));
    assert.equal(new Set(all).size, all.length);
    assert.equal(all.length, 4);
  });

  it("ブラウザのタブを、落とした位置（before の前）に入れる。つけた名前も付いて行く", () => {
    const s = renameBrowser(three(), "t1", "docs");
    const z = moveTabTo(s, browserKey("t1"), "g2", termKey("a", "w3"))!;
    assert.deepEqual(keys(z, "g2"), [browserKey("t1"), termKey("a", "w3")]);
    assert.deepEqual(z.list[1].tabs[0], {
      kind: "browser",
      id: "t1",
      name: "docs",
    });
    // before が移動先のタブでなければ、一番後ろ
    const y = moveTabTo(s, browserKey("t1"), "g2", termKey("a", "w1"))!;
    assert.deepEqual(keys(y, "g2"), [termKey("a", "w3"), browserKey("t1")]);
  });

  it("空のワークスペースへ移せる。移動元の最後のタブを移しても、移動元は空のまま残る", () => {
    const s = three();
    const z = moveTabTo(s, termKey("a", "w3"), "g3", null)!;
    assert.deepEqual(ids(z), ["g1", "g2", "g3"]);
    assert.deepEqual(keys(z, "g2"), []);
    assert.deepEqual(keys(z, "g3"), [termKey("a", "w3")]);
    assert.deepEqual(nums(z), [1, 2, 3]);
    // 移動元に、最後に使ったターミナルのタブの古い参照を残さない
    assert.equal(z.list[1].term, undefined);
    assert.deepEqual(repTerm(z.list[2]), term("a", "w3"));
  });

  it("移動元が最後に使っていたターミナルのタブを移したら、隣のターミナルのタブを最後に使ったものにする。移動先のものは変えない", () => {
    const s = setActiveTerm(three(), "a", "w1");
    const z = moveTabTo(s, termKey("a", "w1"), "g2", null)!;
    assert.deepEqual(z.list[0].term, { target: "b", ws: "w2" });
    assert.deepEqual(z.list[1].term, { target: "a", ws: "w3" });
    // 使っていなかったタブを移しても、移動元の最後に使ったタブは変わらない
    const y = moveTabTo(s, termKey("b", "w2"), "g2", null)!;
    assert.deepEqual(y.list[0].term, { target: "a", ws: "w1" });
  });

  it("同じワークスペースへは、中での並べ替えになる", () => {
    const s = three();
    const z = moveTabTo(s, browserKey("t1"), "g1", termKey("a", "w1"))!;
    assert.deepEqual(keys(z, "g1"), [
      browserKey("t1"),
      termKey("a", "w1"),
      termKey("b", "w2"),
    ]);
    assert.equal(moveTabTo(s, browserKey("t1"), "g1", null), null);
  });

  it("タブか移動先が無ければ null", () => {
    const s = three();
    assert.equal(moveTabTo(s, termKey("a", "zz"), "g2", null), null);
    assert.equal(moveTabTo(s, termKey("a", "w1"), "nope", null), null);
  });

  it("移した所属と並びは、記録に書いて読み直しても同じ", () => {
    const z = moveTabTo(three(), termKey("b", "w2"), "g3", null)!;
    assert.deepEqual(parseGws(JSON.parse(JSON.stringify(z))), z);
  });

  it("移したあとの整理（reconcile）は、タブを元のワークスペースへ戻さない（ブラウザのタブの開いたところが移動元のターミナルのタブでも）", () => {
    const z = moveTabTo(three(), browserKey("t1"), "g2", null)!;
    const r = reconcile(z, {
      lists: { a: list("w1", "w3"), b: list("w2") },
      browser: [{ id: "t1", target: "a", workspace: "w1" }],
    });
    assert.equal(r.state, z);
    assert.deepEqual(r.close, []);
  });
});

describe("タブを移したあとに、移動先が出すタブ（moveTabTo と features/browser/tabs.ts の moveView）", () => {
  it("出していないブラウザのタブを、ブラウザのタブだけのワークスペースの先頭へ入れても、移動先が出すタブは替わらない", () => {
    // A = [ターミナルのタブ, b0]（ターミナルのタブを出している）、B = [b1]。出すタブは、どちらも覚えていない
    let s = addBrowser(
      addWorkspace(EMPTY_GWS, "a", "w1", "w1", "A"),
      "A",
      "b0",
    );
    s = addBrowserWorkspace(s, "b1", "B");
    const tab = (id: string) => ({
      id,
      target: "a",
      workspace: "",
      url: "",
      title: "",
    });
    const t: TabsState = { tabs: [tab("b0"), tab("b1")], views: {} };
    const has = () => true;
    const before = shownBrowserId(s.list[1], t.views.B, has);
    assert.equal(before, "b1");
    const z = moveTabTo(s, browserKey("b0"), "B", browserKey("b1"))!;
    const v = moveView(t, {
      tab: "b0",
      from: "A",
      to: "B",
      show: false,
      destShown: before,
    });
    assert.deepEqual(z.list[1].tabs.map(refKey), [
      browserKey("b0"),
      browserKey("b1"),
    ]);
    assert.equal(shownBrowserId(z.list[1], v.views.B, has), "b1");
  });
});

describe("shownTabKey", () => {
  it("ブラウザのタブを出していればそれ、そうでなければ最後に使ったターミナルのタブ。タブが無ければ undefined", () => {
    const s = addBrowser(two(), "g1", "t1");
    const has = () => true;
    assert.equal(shownTabKey(s.list[0], "t1", has), browserKey("t1"));
    assert.equal(shownTabKey(s.list[0], undefined, has), termKey("a", "w1"));
    assert.equal(
      shownTabKey({ id: "g", name: "", num: 9, tabs: [] }, undefined, has),
      undefined,
    );
  });
});

describe("moveTabStep（t J / t K）", () => {
  const mk = (): GwsState => ({
    list: [
      {
        id: "g1",
        num: 1,
        name: "",
        tabs: [
          { kind: "term", target: "m", ws: "a", title: "" },
          { kind: "browser", id: "b1" },
          { kind: "term", target: "m", ws: "c", title: "" },
        ],
      } as never,
    ],
  });
  const keys = (s: GwsState) => s.list[0].tabs.map(refKey);
  it("1 つ下・上へ動かし、端では動かさない", () => {
    const s = mk();
    const [a, b, c] = keys(s);
    assert.deepEqual(keys(moveTabStep(s, "g1", a, "down")!), [b, a, c]);
    assert.deepEqual(keys(moveTabStep(s, "g1", b, "down")!), [a, c, b]);
    assert.deepEqual(keys(moveTabStep(s, "g1", c, "up")!), [a, c, b]);
    assert.equal(moveTabStep(s, "g1", c, "down"), null);
    assert.equal(moveTabStep(s, "g1", a, "up"), null);
    assert.equal(moveTabStep(s, "g1", "nope", "up"), null);
  });
});

describe("t の操作が数えるタブ（visibleTabs・steppableTabs・moveTabStep の visible）", () => {
  const g = {
    id: "g1",
    num: 1,
    name: "",
    tabs: [
      { kind: "term", target: "m", ws: "a", title: "" },
      { kind: "browser", id: "gone" },
      { kind: "term", target: "off", ws: "b", title: "" },
      { kind: "browser", id: "b1" },
    ],
  } as unknown as Gws;
  const s: GwsState = { list: [g] };
  const has = (id: string) => id === "b1";
  it("消えたブラウザのタブは出ない。つながっていないマシンのタブは t j で飛ばす（今のタブなら残す）", () => {
    const v = visibleTabs(g, has);
    assert.deepEqual(v.map(refKey), [
      termKey("m", "a"),
      termKey("off", "b"),
      browserKey("b1"),
    ]);
    const up = (m: string) => m === "m";
    assert.deepEqual(steppableTabs(v, up, termKey("m", "a")).map(refKey), [
      termKey("m", "a"),
      browserKey("b1"),
    ]);
    assert.deepEqual(steppableTabs(v, up, termKey("off", "b")).map(refKey), [
      termKey("m", "a"),
      termKey("off", "b"),
      browserKey("b1"),
    ]);
  });
  it("t J は、出ていないタブを飛び越えて、出ている隣と入れ替える", () => {
    const v = visibleTabs(g, has);
    const n = moveTabStep(s, "g1", termKey("m", "a"), "down", v)!;
    assert.deepEqual(n.list[0].tabs.map(refKey), [
      browserKey("gone"),
      termKey("off", "b"),
      termKey("m", "a"),
      browserKey("b1"),
    ]);
    const u = moveTabStep(s, "g1", browserKey("b1"), "up", v)!;
    assert.deepEqual(u.list[0].tabs.map(refKey), [
      termKey("m", "a"),
      browserKey("gone"),
      browserKey("b1"),
      termKey("off", "b"),
    ]);
    assert.equal(moveTabStep(s, "g1", browserKey("b1"), "down", v), null);
  });
});

describe("browserOriginOf（足すブラウザのタブの開いたところ）", () => {
  it("ターミナルのタブがあれば、最後に使ったそのタブ", () => {
    const s = setActiveTerm(two(), "b", "w2");
    assert.deepEqual(browserOriginOf(s.list[0], [], "local"), {
      target: "b",
      ws: "w2",
    });
  });

  it("ターミナルのタブが無ければ、中のブラウザのタブのマシンか fallback と、空のワークスペース。ほかのワークスペースのタブは元にしない（#307）", () => {
    const empty = dropTerm(two(), "a", "w3").list[1];
    const tabs = [{ id: "other", target: "far" }];
    assert.deepEqual(browserOriginOf(empty, tabs, "local"), {
      target: "local",
      ws: "",
    });
    const only = addBrowserWorkspace(EMPTY_GWS, "t1", "g9").list[0];
    assert.deepEqual(
      browserOriginOf(only, [...tabs, { id: "t1", target: "dev" }], "local"),
      { target: "dev", ws: "" },
    );
  });
});

describe("hiddenGws（行に出ないワークスペース）", () => {
  it("内蔵ブラウザを使わないとき、ターミナルのタブが無く、ブラウザのタブの記録を持つものだけ", () => {
    // ターミナルのタブ 1 つとブラウザのタブの記録を持つワークスペースの、最後のターミナルのタブを閉じた
    const s = dropTerm(addBrowser(two(), "g2", "t1"), "a", "w3");
    const g2 = s.list[1];
    assert.equal(hiddenGws(g2, false), true);
    assert.equal(hiddenGws(g2, true), false);
    // ターミナルのタブがあれば出る。空のワークスペースは出る
    assert.equal(
      hiddenGws(addBrowser(two(), "g2", "t1").list[1], false),
      false,
    );
    assert.equal(hiddenGws(dropTerm(two(), "a", "w3").list[1], false), false);
  });
});

describe("addEmptyWorkspace（切り替える窓の n。#330）", () => {
  it("タブの無いワークスペースを、並びの一番下に足す", () => {
    let s = addWorkspace(EMPTY_GWS, "local", "w1", "", "g1");
    s = addEmptyWorkspace(s, "", "g2");
    assert.deepEqual(
      s.list.map((g) => [g.id, g.name, g.num, g.tabs.length]),
      [
        ["g1", "", 1, 1],
        ["g2", "", 2, 0],
      ],
    );
    assert.equal(displayName(s.list[1]), "ws2");
  });
  it("名前を付けて作れる（前後の空白は除く）。空きの一番小さい番号になる", () => {
    let s = addEmptyWorkspace(EMPTY_GWS, "  docs ", "g1");
    s = addEmptyWorkspace(s, "", "g2");
    s = removeGws(s, "g1");
    s = addEmptyWorkspace(s, "", "g3");
    assert.equal(s.list[0].num, 2);
    assert.equal(s.list[1].num, 1);
    assert.equal(
      displayName(addEmptyWorkspace(EMPTY_GWS, "  docs ").list[0]),
      "docs",
    );
  });
});

describe("DB のタブ（#347）", () => {
  const db = (id: string, target = "a", connection = "prod") =>
    ({ kind: "db", id, target, connection }) as const;
  const none = () => false;
  /** g1 に a の w1 と DB のタブ db1、g2 に DB のタブ db2 だけ。 */
  function withDb(): GwsState {
    let s = addWorkspace(EMPTY_GWS, "a", "w1", "w1", "g1");
    s = addEmptyWorkspace(s, "", "g2");
    s = addDb(s, "g1", db("db1"));
    return addDb(s, "g2", db("db2", "b", "dev"));
  }

  it("id は db で始まり、ブラウザのタブの id（t で始まる）と重ならない", () => {
    assert.match(
      newDbTabId(() => 0.5),
      /^db[0-9a-z]{12}$/,
    );
    assert.notEqual(dbKey("x"), browserKey("x"));
  });

  it("足す・外す。同じ id は 2 度足さない。外しても、ワークスペースは空のまま残る", () => {
    let s = withDb();
    assert.equal(gwsOfDb(s, "db1")?.id, "g1");
    assert.equal(addDb(s, "g2", db("db1")), s);
    assert.deepEqual(
      dbTabsOf(s).map((r) => r.id),
      ["db1", "db2"],
    );
    s = removeDb(s, "db2");
    assert.equal(gwsOfDb(s, "db2"), undefined);
    assert.deepEqual(ids(s), ["g1", "g2"]);
    assert.equal(s.list[1].tabs.length, 0);
  });

  it("記録に書いて読み直すと、マシン・接続・名前・並びが戻る。形の違うものは捨てる", () => {
    const s = renamePage(withDb(), dbKey("db1"), " main ");
    const back = parseGws(JSON.parse(JSON.stringify(s)));
    assert.deepEqual(back.list[0].tabs[1], {
      kind: "db",
      id: "db1",
      target: "a",
      connection: "prod",
      name: "main",
    });
    assert.deepEqual(
      parseGws({
        list: [
          {
            id: "g",
            num: 1,
            tabs: [
              { kind: "db", id: "x", target: "a" },
              { kind: "db", id: "y", connection: "c" },
            ],
          },
        ],
      }).list[0].tabs,
      [],
    );
  });

  it("環境の変種は、記録に書いて読み直すと戻る。変種の無い接続には付かない", () => {
    let s = addEmptyWorkspace(EMPTY_GWS, "", "g1");
    s = addDb(s, "g1", { ...db("db1", "a", "shop"), variant: "prod" });
    s = addDb(s, "g1", db("db2", "a", "shop"));
    const back = parseGws({
      ...JSON.parse(JSON.stringify(s)),
    });
    assert.deepEqual(back.list[0].tabs, [
      {
        kind: "db",
        id: "db1",
        target: "a",
        connection: "shop",
        variant: "prod",
      },
      { kind: "db", id: "db2", target: "a", connection: "shop" },
    ]);
    // 文字でない・空の variant は、変種が無いものとして読む
    const odd = JSON.parse(JSON.stringify(s));
    odd.list[0].tabs[0].variant = 1;
    odd.list[0].tabs[1].variant = "";
    assert.deepEqual(
      parseGws(odd).list[0].tabs.map((r) => "variant" in r),
      [false, false],
    );
  });

  it("出す名前は、変種があれば「接続 (変種)」。要求の引数は、変種があるときだけ variant を持つ", () => {
    assert.equal(dbLabel("shop", "prod"), "shop (prod)");
    assert.equal(dbLabel("shop"), "shop");
    assert.equal(dbLabel("shop", ""), "shop");
    assert.equal(
      dbRefLabel({ connection: "shop", variant: "prod" }),
      "shop (prod)",
    );
    assert.deepEqual(dbRefParams({ connection: "shop", variant: "prod" }), {
      connection: "shop",
      variant: "prod",
    });
    assert.deepEqual(dbRefParams({ connection: "shop" }), {
      connection: "shop",
    });
  });

  it("名前を空にすると、接続の名前に戻る（名前を外す）", () => {
    let s = renamePage(withDb(), dbKey("db1"), "main");
    s = renamePage(s, dbKey("db1"), "  ");
    assert.equal("name" in s.list[0].tabs[1], false);
  });

  it("出しているタブ：views に DB のタブがあればそれ。ターミナルのタブが無ければ、並びで最初のページのタブ", () => {
    const s = withDb();
    const [g1, g2] = s.list;
    assert.deepEqual(shownPage(g1, "db1", none), db("db1"));
    assert.equal(shownPage(g1, undefined, none), undefined);
    assert.deepEqual(shownPage(g2, undefined, none), db("db2", "b", "dev"));
    assert.equal(shownTabKey(g1, "db1", none), dbKey("db1"));
    assert.equal(shownTabKey(g1, undefined, none), termKey("a", "w1"));
    // DB のタブを出しているときは、ブラウザのタブは出していない
    assert.equal(shownBrowserId(g1, "db1", none), undefined);
    assert.equal(shownDb(g1, "db1", none)?.id, "db1");
  });

  it("ブラウザのタブより前にある DB のタブは、ターミナルのタブが無いワークスペースで先に出る", () => {
    let s = addEmptyWorkspace(EMPTY_GWS, "", "g");
    s = addDb(s, "g", db("d"));
    s = addBrowser(s, "g", "t1");
    assert.equal(shownPage(s.list[0], undefined, () => true)?.id, "d");
    assert.equal(shownPage(s.list[0], "t1", () => true)?.id, "t1");
  });

  it("サイドバーに出て、t j / t k で移れる（マシンにつながっていなくても、入力欄は見られる）", () => {
    const g = withDb().list[0];
    assert.deepEqual(visibleTabs(g, none).map(refKey), [
      termKey("a", "w1"),
      dbKey("db1"),
    ]);
    assert.deepEqual(
      steppableTabs(visibleTabs(g, none), none, termKey("a", "w1")).map(refKey),
      [termKey("a", "w1"), dbKey("db1")],
    );
  });

  it("DB のタブがあるワークスペースは、内蔵ブラウザを使わなくても行に出る", () => {
    let s = addEmptyWorkspace(EMPTY_GWS, "", "g");
    s = addBrowser(s, "g", "t1");
    assert.equal(hiddenGws(s.list[0], false), true);
    s = addDb(s, "g", db("d"));
    assert.equal(hiddenGws(s.list[0], false), false);
  });

  it("reconcile は DB のタブを外さない（ブラウザのタブの一覧に無くても）", () => {
    const s = withDb();
    const r = reconcile(s, { lists: { a: list("w1") }, browser: [] });
    assert.deepEqual(
      dbTabsOf(r.state).map((x) => x.id),
      ["db1", "db2"],
    );
    assert.deepEqual(r.close, []);
  });

  it("別のワークスペースへ移せる。移す先で出すと、views は DB のタブの id になる", () => {
    const s = withDb();
    const next = moveTabTo(s, dbKey("db1"), "g2", null)!;
    assert.equal(gwsOfDb(next, "db1")?.id, "g2");
    const v: TabsState = { tabs: [], views: { g1: "db1" } };
    assert.deepEqual(
      moveView(v, { tab: "db1", from: "g1", to: "g2", show: true }).views,
      { g2: "db1" },
    );
  });
});
