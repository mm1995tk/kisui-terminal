import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ErrorCode, RpcError } from "../rpc/message.ts";
import type { TermInfo, Workspace } from "../rpc/protocol.ts";
import { TermGroup, TermGroups, type TermLayout } from "./group.ts";
import { EXITED_NOTICE, type TermPort, type TermSink } from "./link.ts";

function alive(termId: string): TermInfo {
  return {
    termId,
    pid: 1,
    cwd: "/w",
    workspaceId: "w1",
    primary: false,
    title: "",
    cols: 80,
    rows: 24,
    alive: true,
  };
}

/** 返事をすぐ返す偽の shj。term.create は t10, t11, … と作る。 */
function fakePort() {
  const calls: { method: string; params: any }[] = [];
  let next = 9;
  const handlers: Record<string, (params: any) => unknown> = {
    // 欄のターミナルは全部動いている
    "term.list": () => ({
      terms: ["t1", "t2", "t3", "t10", "t11"].map(alive),
    }),
    "term.create": () => ({ termId: `t${++next}`, pid: 1, cwd: "/w" }),
    "term.attach": () => ({ seq: 0, snapshot: "", cols: 80, rows: 24 }),
    "term.input": () => ({}),
    "term.resize": () => ({}),
    "term.close": () => ({}),
    "term.restart": () => ({ pid: 2, cwd: "/w" }),
    "layout.resize": (p) => ({ ratio: p.ratio }),
  };
  const port: TermPort = {
    async request(method, params) {
      calls.push({ method, params });
      const r = handlers[method]!(params);
      if (r instanceof Error) throw r;
      return r as never;
    },
    ackTerm() {},
  };
  return { port, calls, handlers };
}

function sink(): TermSink & { text: string } {
  const s = {
    text: "",
    write(data: Uint8Array, done: () => void) {
      s.text += new TextDecoder().decode(data);
      done();
    },
    notice(t: string) {
      s.text += t;
    },
    reset() {
      s.text = "";
    },
  };
  return s;
}

const tick = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

/** 画面の代わりに、並んだターミナルを全部 bind する。 */
function bindAll(g: TermGroup, sinks = new Map<unknown, TermSink>()) {
  for (const l of g.list) {
    if (sinks.has(l)) continue;
    const s = sink();
    sinks.set(l, s);
    l.bind(s);
  }
  return sinks;
}

const layout = (terms: string[] = [], primary = "t1"): TermLayout => ({
  id: "w1",
  primary,
  terms,
});
const ids = (g: TermGroup) => g.list.map((l) => l.id);
const extraId = (g: TermGroup): string | undefined => g.activeExtra?.id;
const extraIds = (g: TermGroup): string[] => g.extras.map((x) => x.id);

describe("TermGroup", () => {
  it("プライマリを先頭に、分割したターミナルを続けて並べる。最初の active はプライマリ", () => {
    const f = fakePort();
    const g = new TermGroup(f.port, layout(["t2", "t3"]), () => {});
    assert.deepEqual(ids(g), ["t1", "t2", "t3"]);
    assert.equal(g.active?.id, "t1");
    assert.equal(g.list[0]!.primary, true);
    assert.equal(g.list[1]!.primary, false);
    assert.deepEqual(f.calls, [], "作るのは shj。ここでは何も送らない");
  });

  it("shj の一覧が変わったら合わせる。残るものは同じ TermLink のまま", () => {
    const f = fakePort();
    let changes = 0;
    const g = new TermGroup(f.port, layout(["t2"]), () => changes++);
    const before = [...g.list];
    g.update(layout(["t2"]));
    assert.equal(changes, 0, "同じなら通知しない");
    g.update(layout(["t2", "t3"]));
    assert.deepEqual(ids(g), ["t1", "t2", "t3"]);
    assert.equal(g.list[0], before[0]);
    assert.equal(g.list[1], before[1]);
    assert.equal(changes, 1);

    g.setActive(2);
    g.update(layout(["t2"])); // t3 が消えた（active だった）
    assert.deepEqual(ids(g), ["t1", "t2"]);
    assert.equal(g.active?.id, "t2");
  });

  it("プライマリが外れて分割したターミナルが昇格したら、同じ TermLink がプライマリになる", () => {
    const f = fakePort();
    const g = new TermGroup(f.port, layout(["t2", "t3"]), () => {});
    const t2 = g.list[1]!;
    g.update(layout(["t3"], "t2"));
    assert.deepEqual(ids(g), ["t2", "t3"]);
    assert.equal(g.list[0], t2);
    assert.equal(t2.primary, true);
    assert.equal(t2.onExit, undefined);
  });

  it("shj が出した欄（termId）を active にする。無ければ false", () => {
    const f = fakePort();
    const g = new TermGroup(f.port, layout(["t2", "t3"]), () => {});
    assert.equal(g.activate("t3"), true);
    assert.equal(g.active?.id, "t3");
    assert.equal(g.activate("t9"), false);
    assert.equal(g.active?.id, "t3");
  });

  it("ターミナルでない欄（動画）を、ターミナルの後ろに並べる。変わらなければ同じ物のまま残す", () => {
    const f = fakePort();
    let changed = 0;
    const x1 = {
      id: "x1",
      kind: "video",
      path: "/v/a.mp4",
      mime: "video/mp4",
      size: 5,
    } as const;
    const g = new TermGroup(
      f.port,
      { ...layout(["t2"]), extras: [x1] },
      () => changed++,
    );
    assert.deepEqual(
      g.extras.map((x) => x.id),
      ["x1"],
    );
    assert.equal(extraId(g), undefined);
    // workspace.changed が同じ欄を届け直しても、作り直さない（動画を取り直さない）
    const kept = g.extras[0];
    g.update({ ...layout(["t2"]), extras: [{ ...x1 }] });
    assert.equal(g.extras[0], kept);
    assert.equal(changed, 0);
    assert.equal(g.activateExtra("x1"), true);
    assert.equal(extraId(g), "x1");
    assert.equal(g.activateExtra("x9"), false);
    // ターミナルを押すと、欄からキーが戻る。今のターミナルを押し直しても戻る
    g.setActive(1);
    assert.equal(extraId(g), undefined);
    // 欄が一覧から消えたら外す
    g.activateExtra("x1");
    g.update(layout(["t2"]));
    assert.deepEqual(extraIds(g), []);
    assert.equal(extraId(g), undefined);
  });

  it("openUrl は extra.open を送る（ターミナルの URL のクリック）", async () => {
    const f = fakePort();
    f.handlers["extra.open"] = () => ({ id: "x1" });
    const g = new TermGroup(f.port, layout(["t2"]), () => {});
    await g.openUrl("https://example.com/");
    assert.deepEqual(f.calls.at(-1), {
      method: "extra.open",
      params: { workspaceId: "w1", url: "https://example.com/" },
    });
  });

  it("欄を閉じると extra.close を送り、一覧から消えるまで並べ直さない。Cmd+W も欄を閉じる", () => {
    const f = fakePort();
    f.handlers["extra.close"] = () => ({});
    const x1 = {
      id: "x1",
      kind: "video",
      path: "/v/a.mp4",
      mime: "video/mp4",
      size: 5,
    } as const;
    const g = new TermGroup(
      f.port,
      { ...layout(["t2"]), extras: [x1] },
      () => {},
    );
    g.activateExtra("x1");
    assert.equal(g.closeActive(), true);
    assert.deepEqual(f.calls.at(-1), {
      method: "extra.close",
      params: { workspaceId: "w1", id: "x1" },
    });
    assert.deepEqual(extraIds(g), []);
    g.update({ ...layout(["t2"]), extras: [x1] }); // 返事の前に届いた古い一覧
    assert.deepEqual(extraIds(g), []);
    g.update(layout(["t2"]));
    g.update({ ...layout(["t2"]), extras: [{ ...x1, id: "x2" }] }); // 次の動画は並ぶ
    assert.deepEqual(
      g.extras.map((x) => x.id),
      ["x2"],
    );
  });

  it("隣へ移るとき、ターミナルでない欄も木に入る。欄の数に上限は無い", async () => {
    const f = fakePort();
    const x1 = {
      id: "x1",
      kind: "video",
      path: "/v/a.mp4",
      mime: "video/mp4",
      size: 5,
    } as const;
    const g = new TermGroup(
      f.port,
      { ...layout(["t2"]), extras: [x1] },
      () => {},
    );
    g.setActive(1);
    // 木が無い（古い serve）ので自動：t1 の右に t2 と x1 が上下に並ぶ
    assert.equal(g.move("down"), true);
    assert.equal(extraId(g), "x1");
    assert.equal(g.move("down"), false);
    assert.equal(g.move("up"), true);
    assert.equal(g.active?.id, "t2");
    assert.equal(extraId(g), undefined);
    assert.equal(g.move("left"), true);
    assert.equal(g.active?.id, "t1");
    for (let i = 0; i < 8; i++) assert.equal(await g.add(), true);
    assert.equal(g.list.length + g.extras.length, 11);
  });

  it("足すと term.create（ワークスペースと分ける欄と向きを指して）で作って active にする。数に上限は無い", async () => {
    const f = fakePort();
    const g = new TermGroup(f.port, layout(), () => {});
    assert.equal(await g.add("down"), true);
    assert.deepEqual(f.calls[0], {
      method: "term.create",
      params: {
        workspaceId: "w1",
        cols: 80,
        rows: 24,
        split: { target: "t1", dir: "down" },
      },
    });
    assert.deepEqual(ids(g), ["t1", "t10"]);
    assert.equal(g.active?.id, "t10");
    // workspace.changed が後から届いても、重ねて並べない
    g.update(layout(["t10"]));
    assert.deepEqual(ids(g), ["t1", "t10"]);
    for (let i = 0; i < 6; i++) assert.equal(await g.add(), true);
    assert.equal(g.list.length, 8);
    // 二度目からは、今の欄（直前に足した欄）を分ける
    assert.deepEqual(f.calls[1]!.params.split, { target: "t10", dir: "right" });
  });

  it("workspace.changed が term.create の返事より先に届いても、重ねて並べない", async () => {
    const f = fakePort();
    const g = new TermGroup(f.port, layout(), () => {});
    f.handlers["term.create"] = () => {
      g.update(layout(["t10"])); // 通知が先
      return { termId: "t10", pid: 1, cwd: "/w" };
    };
    assert.equal(await g.add(), true);
    assert.deepEqual(ids(g), ["t1", "t10"]);
    assert.equal(g.active?.id, "t10");
  });

  it("term.create が断られたら知らせて false", async () => {
    const f = fakePort();
    const errors: string[] = [];
    const g = new TermGroup(
      f.port,
      layout(),
      () => {},
      (m) => errors.push(m),
    );
    f.handlers["term.create"] = () =>
      new RpcError({ code: ErrorCode.Busy, message: "full" });
    assert.equal(await g.add(), false);
    assert.equal(errors.length, 1);
    assert.deepEqual(ids(g), ["t1"]);
  });

  it("矢印で隣へ移り、端では動かない", () => {
    const f = fakePort();
    const g = new TermGroup(f.port, layout(["t2"]), () => {});
    assert.equal(g.move("right"), true);
    assert.equal(g.active?.id, "t2");
    assert.equal(g.move("right"), false);
    assert.equal(g.move("left"), true);
    assert.equal(g.active?.id, "t1");
  });

  it("分割したターミナルのシェルが終わったら欄を閉じて並び直し、term.close を送る。shj の一覧から消えるまで戻さない", async () => {
    const f = fakePort();
    const g = new TermGroup(f.port, layout(["t2", "t3"]), () => {});
    bindAll(g);
    await tick();
    g.setActive(1);
    f.calls.length = 0;
    g.handle({ method: "term.exit", params: { termId: "t2", code: 0 } });
    await tick();
    assert.deepEqual(ids(g), ["t1", "t3"]);
    assert.equal(g.active?.id, "t3", "隣が active になる");
    assert.ok(
      f.calls.some(
        (c) => c.method === "term.close" && c.params.termId === "t2",
      ),
    );
    // term.close の結果が workspace.changed で届く前の一覧に t2 が残っていても、並べ直さない
    g.update(layout(["t2", "t3"]));
    assert.deepEqual(ids(g), ["t1", "t3"]);
    g.update(layout(["t3"]));
    assert.deepEqual(ids(g), ["t1", "t3"]);
  });

  it("closeActive：分割したターミナルを閉じて term.close を送り、隣が active になる。同じ id の term.exit が来ても二重に閉じない", async () => {
    const f = fakePort();
    const g = new TermGroup(f.port, layout(["t2", "t3"]), () => {});
    bindAll(g);
    await tick();
    g.setActive(1);
    f.calls.length = 0;
    assert.equal(g.closeActive(), true);
    await tick();
    assert.deepEqual(ids(g), ["t1", "t3"]);
    assert.equal(g.active?.id, "t3");
    g.handle({ method: "term.exit", params: { termId: "t2", code: 0 } });
    await tick();
    assert.deepEqual(ids(g), ["t1", "t3"]);
    assert.equal(
      f.calls.filter((c) => c.method === "term.close").length,
      1,
      "term.close は 1 回だけ",
    );
  });

  it("closeActive：プライマリターミナルが active なら何も閉じず、term.close も送らない", async () => {
    const f = fakePort();
    const g = new TermGroup(f.port, layout(["t2"]), () => {});
    bindAll(g);
    await tick();
    f.calls.length = 0;
    assert.equal(g.active?.id, "t1");
    assert.equal(g.closeActive(), false);
    await tick();
    assert.deepEqual(ids(g), ["t1", "t2"]);
    assert.equal(g.active?.id, "t1");
    assert.ok(!f.calls.some((c) => c.method === "term.close"));
  });

  it("プライマリターミナルのシェルが終わっても欄を閉じず、Enter で作り直せる", async () => {
    const f = fakePort();
    const g = new TermGroup(f.port, layout(["t2"]), () => {});
    const sinks = bindAll(g) as Map<unknown, TermSink & { text: string }>;
    await tick();
    g.handle({ method: "term.exit", params: { termId: "t1", code: 0 } });
    await tick();
    assert.deepEqual(ids(g), ["t1", "t2"]);
    assert.ok(sinks.get(g.list[0])!.text.endsWith(EXITED_NOTICE));
    f.calls.length = 0;
    g.list[0]!.input(new TextEncoder().encode("\r"));
    await tick();
    assert.equal(f.calls[0]!.method, "term.restart");
    assert.ok(!f.calls.some((c) => c.method === "term.close"));
  });
});

describe("TermGroups", () => {
  const ws = (
    id: string,
    primary: string,
    terms: string[] = [],
  ): Workspace => ({
    id,
    folder: null,
    kind: null,
    name: null,
    primary,
    terms,
  });

  it("ワークスペースごとに持ち、増えたら作り、消えたら忘れる。残るものは同じまま", () => {
    const f = fakePort();
    let changes = 0;
    const gs = new TermGroups(f.port, () => changes++);
    gs.sync([ws("a", "t1")]);
    const a = gs.get("a")!;
    assert.equal(a.active?.id, "t1");
    assert.equal(changes, 1);
    gs.sync([ws("a", "t1", ["t3"]), ws("b", "t2")]);
    assert.equal(gs.get("a"), a);
    assert.deepEqual(ids(a), ["t1", "t3"]);
    assert.deepEqual(ids(gs.get("b")!), ["t2"]);
    gs.sync([ws("b", "t2")]);
    assert.equal(gs.get("a"), undefined);
    assert.ok(gs.get("b"));
  });

  it("通知は termId が合うワークスペースの欄だけが受ける", async () => {
    const f = fakePort();
    const gs = new TermGroups(f.port, () => {});
    gs.sync([ws("a", "t1"), ws("b", "t2")]);
    const sa = sink();
    const sb = sink();
    gs.get("a")!.list[0]!.bind(sa);
    gs.get("b")!.list[0]!.bind(sb);
    await tick();
    gs.handle({
      method: "term.output",
      params: { termId: "t2", seq: 2, data: btoa("hi") },
    });
    assert.equal(sa.text, "");
    assert.equal(sb.text, "hi");
  });
});

describe("欄どうしの境界を動かす（#18）", () => {
  const split = (terms: string[]): TermLayout => ({
    ...layout(terms),
    layout: {
      dir: "right",
      ratio: 0.5,
      a: { pane: "t1" },
      b: { pane: "t2" },
    },
  });

  it("すぐ画面に出して layout.resize を送り、返事のあとは serve の木に任せる", async () => {
    const f = fakePort();
    f.handlers["layout.resize"] = (p) => ({ ratio: p.ratio });
    let changes = 0;
    const g = new TermGroup(f.port, split(["t2"]), () => changes++);
    assert.equal(g.setBorder("t2", 0.3), true);
    assert.equal((g.layout as { ratio: number }).ratio, 0.3, "送る前から出る");
    assert.equal(changes, 1);
    await tick();
    assert.deepEqual(f.calls.at(-1), {
      method: "layout.resize",
      params: { workspaceId: "w1", pane: "t2", ratio: 0.3 },
    });
    // serve の木が届く。重ねていた割合は外れ、serve の値が出る
    g.update({
      ...split(["t2"]),
      layout: { ...split(["t2"]).layout!, ratio: 0.3 } as never,
    });
    assert.equal((g.layout as { ratio: number }).ratio, 0.3);
  });

  it("送っている間に動かした分は、最新の 1 つだけを次に送る", async () => {
    const f = fakePort();
    const waits: (() => void)[] = [];
    f.port.request = async (method, params: any) => {
      f.calls.push({ method, params });
      if (method === "layout.resize")
        await new Promise<void>((r) => waits.push(r));
      return { ratio: params.ratio } as never;
    };
    const g = new TermGroup(f.port, split(["t2"]), () => {});
    g.setBorder("t2", 0.3);
    g.setBorder("t2", 0.4);
    g.setBorder("t2", 0.45);
    await tick();
    const sent = () => f.calls.filter((c) => c.method === "layout.resize");
    assert.equal(sent().length, 1, "返事が来るまで次は送らない");
    waits.shift()!();
    await tick();
    assert.deepEqual(
      sent().map((c) => c.params.ratio),
      [0.3, 0.45],
    );
    waits.shift()!();
    await tick();
  });

  it("最小の大きさを下回る位置には動かさない。境界が無ければ false", async () => {
    const f = fakePort();
    f.handlers["layout.resize"] = (p) => ({ ratio: p.ratio });
    const g = new TermGroup(f.port, split(["t2"]), () => {});
    g.setBorder("t2", 0.01); // 80 列の 2 枚：20 / 160 = 0.125
    assert.equal((g.layout as { ratio: number }).ratio, 0.125);
    assert.equal(g.setBorder("t9", 0.5), false);
    await tick();
  });

  it("serve が断ったら理由を出し、重ねていた割合を外す", async () => {
    const f = fakePort();
    f.handlers["layout.resize"] = () =>
      new RpcError({ code: ErrorCode.Busy, message: "too small" });
    const errors: string[] = [];
    const g = new TermGroup(
      f.port,
      split(["t2"]),
      () => {},
      (m) => errors.push(m),
    );
    g.setBorder("t2", 0.3);
    await tick();
    assert.equal(errors.length, 1);
    assert.equal((g.layout as { ratio: number }).ratio, 0.5);
  });
});

describe("欄の名前", () => {
  it("titles を持ち、変わったら onChange を呼ぶ", () => {
    const f = fakePort();
    let changes = 0;
    const g = new TermGroup(f.port, layout(["t2"]), () => changes++);
    assert.deepEqual(g.titles, {});
    g.update({ ...layout(["t2"]), titles: { t1: "build" } });
    assert.deepEqual(g.titles, { t1: "build" });
    assert.equal(changes, 1);
    g.update({ ...layout(["t2"]), titles: { t1: "build" } });
    assert.equal(changes, 1);
    g.update(layout(["t2"]));
    assert.deepEqual(g.titles, {});
    assert.equal(changes, 2);
  });
});
