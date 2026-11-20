import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PaneOpenRequest } from "../../../infrastructure/rpc/protocol.ts";
import {
  addEmptyWorkspace,
  addWorkspace,
  EMPTY_GWS,
  gwsOfTerm,
  rename,
  termKey,
  type GwsState,
} from "../model.ts";
import { createPaneOpen, placeOpenedTab, planPaneOpen } from "./paneOpen.ts";

// g1「review」（a の w1）・g2「ws2」（a の w2）・g3「x」・g4「x」
function state(): GwsState {
  let s = addWorkspace(EMPTY_GWS, "a", "w1", "w1", "g1");
  s = addWorkspace(s, "a", "w2", "w2", "g2");
  s = rename(s, "g1", "review");
  s = addEmptyWorkspace(s, "x", "g3");
  return addEmptyWorkspace(s, "x", "g4");
}

describe("kisui pane open の入れ先", () => {
  it("名前のワークスペースが 1 つだけならそこ。番号の名前でも指せる", () => {
    assert.deepEqual(planPaneOpen(state(), " review ", false), {
      kind: "into",
      gid: "g1",
    });
    assert.deepEqual(planPaneOpen(state(), "ws2", false), {
      kind: "into",
      gid: "g2",
    });
  });

  it("無い・2 つ以上なら断る。--new で、もうあれば断る。名前の決まりに合わなければ断る", () => {
    const err = (p: ReturnType<typeof planPaneOpen>) =>
      p.kind === "error" ? p.error : "";
    assert.match(err(planPaneOpen(state(), "nope", false)), /nope/);
    assert.match(err(planPaneOpen(state(), "x", false)), /2/);
    assert.match(err(planPaneOpen(state(), "review", true)), /review/);
    assert.match(err(planPaneOpen(state(), "ws2", true)), /ws2/);
    assert.equal(planPaneOpen(state(), "a".repeat(101), true).kind, "error");
    assert.deepEqual(planPaneOpen(state(), " new ", true), {
      kind: "new",
      name: "new",
    });
  });

  it("作ったタブを一番後ろに入れ、最後に使っていたタブは変えない", () => {
    const s = placeOpenedTab(
      state(),
      { kind: "into", gid: "g1" },
      "review",
      "a",
      "w9",
    );
    assert.deepEqual(
      s.list[0].tabs.map((r) => (r.kind === "term" ? r.ws : r.id)),
      ["w1", "w9"],
    );
    assert.deepEqual(s.list[0].term, { target: "a", ws: "w1" });
    assert.equal(s.list.length, 4);
  });

  it("--new なら、その名前のワークスペースを並びの一番下に作って入れる", () => {
    const s = placeOpenedTab(
      state(),
      { kind: "new", name: "new" },
      "new",
      "a",
      "w9",
      "g5",
    );
    assert.equal(s.list.length, 5);
    assert.equal(s.list[4].name, "new");
    assert.equal(gwsOfTerm(s, "a", "w9")?.id, "g5");
  });

  it("待つ間に入れ先が閉じられていたら、その名前で作り直す", () => {
    const s = placeOpenedTab(
      state(),
      { kind: "into", gid: "gone" },
      " review2 ",
      "a",
      "w9",
      "g5",
    );
    assert.equal(gwsOfTerm(s, "a", "w9")?.id, "g5");
    assert.equal(s.list[4].name, "review2");
  });

  it("一覧の知らせが先に届いて別のワークスペースとして入っていたら、そこから移す", () => {
    const orphan = addWorkspace(state(), "a", "w9", "w9", "g9");
    const s = placeOpenedTab(
      orphan,
      { kind: "into", gid: "g1" },
      "review",
      "a",
      "w9",
    );
    assert.equal(gwsOfTerm(s, "a", "w9")?.id, "g1");
    assert.equal(
      s.list.some((g) => g.id === "g9"),
      false,
    );
  });
});

describe("kisui pane open の頼み", () => {
  const rq: PaneOpenRequest = {
    id: "o1",
    workspace: "review",
    name: "reviewer",
    dir: "/src",
    argv: ["/bin/claude"],
    env: ["PATH=/bin"],
  };

  function setup(opts: {
    connected?: boolean;
    create?: () => Promise<{ id: string; termId: string }>;
  }) {
    let gws = state();
    const calls: unknown[] = [];
    const justCreated = new Set<string>();
    const session = {
      createWorkspace: (dir?: string, cmd?: unknown) => {
        calls.push({ dir, cmd });
        return (opts.create ?? (async () => ({ id: "w9", termId: "t9" })))();
      },
    };
    const open = createPaneOpen({
      sessions: {
        sessions: () => ({ a: session }) as never,
        states: () =>
          ({
            a: { kind: opts.connected === false ? "connecting" : "connected" },
          }) as never,
        workspaces: () => ({ a: [] }) as never,
        labelOf: (t: string) => t,
      },
      gws: () => gws,
      setGws: (f) => {
        gws = f(gws);
      },
      justCreated,
    });
    return { open, calls, justCreated, gws: () => gws };
  }

  it("マシンにタブを作らせ、ワークスペースに入れて、ペインの id を返す", async () => {
    const t = setup({});
    assert.deepEqual(await t.open("a", rq), { termId: "t9" });
    assert.deepEqual(t.calls, [
      {
        dir: "/src",
        cmd: { argv: ["/bin/claude"], env: ["PATH=/bin"], name: "reviewer" },
      },
    ]);
    assert.equal(gwsOfTerm(t.gws(), "a", "w9")?.id, "g1");
    assert.ok(t.justCreated.has(termKey("a", "w9")));
  });

  it("入れ先が決まらなければ、マシンに頼まずに断る", async () => {
    const t = setup({});
    const r = await t.open("a", { ...rq, workspace: "nope" });
    assert.ok("error" in r);
    assert.deepEqual(t.calls, []);
  });

  it("マシンにつながっていない・マシンが断ったら、その理由を返す（ワークスペースは作らない）", async () => {
    const off = setup({ connected: false });
    assert.ok("error" in (await off.open("a", rq)));
    const refused = setup({
      create: async () => {
        throw new Error("the name is already used by another pane");
      },
    });
    assert.deepEqual(
      await refused.open("a", { ...rq, new: true, workspace: "n" }),
      {
        error: "the name is already used by another pane",
      },
    );
    assert.equal(refused.gws().list.length, 4);
  });
});
