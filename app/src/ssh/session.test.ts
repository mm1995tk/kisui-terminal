import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ClosedEvent, ShellApi } from "./api.ts";
import { applyWorkspaceChange, Session, type SessionState } from "./session.ts";

type Line = (e: { id: string; line: string }) => void;

/** 接続ごとに挙動を決められる偽の殻。 */
function fakeShell(opts: {
  serverIds: string[]; // n 回目の接続の serverId。"fail" なら ssh が終わる、"missing" なら kisui が無い（97）
  installFails?: string; // 入れるのがこの理由で失敗する
  installHangs?: boolean; // 入れる処理が終わらない（取り消されるまで）
  pingReply?: () => boolean;
  /** ping にこのエラーで答える（引き継がれた後の not_owner など） */
  pingError?: () => { code: number; message: string } | undefined;
  /** workspace.list で返すフォーカス */
  focus?: string | null;
}) {
  const lines: Line[] = [];
  const closeds: ((e: ClosedEvent) => void)[] = [];
  const sent: { id: string; msg: any }[] = [];
  let n = 0;
  const installs: string[] = [];
  const cancels: string[] = [];
  const installIds: string[] = [];
  const hang: (() => void)[] = [];
  const serverOf = new Map<string, string>();
  const emit = (id: string, obj: unknown) =>
    lines.forEach((f) => f({ id, line: JSON.stringify(obj) }));
  const api: ShellApi = {
    listSshHosts: async () => [],
    configMachines: async () => [],
    connect: async (id) => {
      const sid = opts.serverIds[Math.min(n, opts.serverIds.length - 1)];
      n++;
      if (sid === "fail" || sid === "missing") {
        queueMicrotask(() =>
          closeds.forEach((f) =>
            f({ id, code: sid === "missing" ? 97 : 255, stderr: "refused" }),
          ),
        );
        return;
      }
      serverOf.set(id, sid);
      lines.forEach((f) => f({ id, line: "@@shj-rpc 1@@" }));
    },
    send: async (id, text) => {
      const msg = JSON.parse(text);
      sent.push({ id, msg });
      const reply = (result: unknown) =>
        queueMicrotask(() => emit(id, { jsonrpc: "2.0", id: msg.id, result }));
      switch (msg.method) {
        case "session.hello":
          reply({
            protocol: { major: 4, minor: 0 },
            encoding: "json",
            shj: { version: "1", commit: "x", channel: "stable" },
            serverId: serverOf.get(id),
            startedAt: "now",
            capabilities: [],
            workspaces: [{ id: `w-${serverOf.get(id)}` }],
            rev: 3,
          });
          break;
        case "workspace.list":
          reply({
            workspaces: [{ id: `w-${serverOf.get(id)}` }],
            focus: opts.focus ?? null,
          });
          break;
        case "workspace.focus":
          if (msg.params.id === "nope") {
            queueMicrotask(() =>
              emit(id, {
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32001, message: "no such workspace: nope" },
              }),
            );
            break;
          }
          reply(
            msg.params.id === "w-A" ? { rev: 9, termId: "t-A" } : { rev: 9 },
          );
          break;
        case "session.ping": {
          const error = opts.pingError?.();
          if (error) {
            queueMicrotask(() =>
              emit(id, { jsonrpc: "2.0", id: msg.id, error }),
            );
            break;
          }
          if (opts.pingReply?.() ?? true) reply({});
          break;
        }
        case "tree.watch":
          reply({});
          break;
        case "session.bye":
          reply({});
          break;
      }
    },
    disconnect: async () => {},
    askpassReply: async () => {},
    onLine: async (f) => {
      lines.push(f);
      return () => void lines.splice(lines.indexOf(f), 1);
    },
    onClosed: async (f) => {
      closeds.push(f);
      return () => void closeds.splice(closeds.indexOf(f), 1);
    },
    onAskpass: async () => () => {},
    installPlan: async () => ({
      version: "0.0.0",
      path: "~/.cache/shijimi-editor/0.0.0/kisui",
      release_url: "https://example.invalid/r",
    }),
    installCancel: async (id) => {
      cancels.push(id);
    },
    installRemote: async (id, target) => {
      if (opts.installHangs) {
        installIds.push(id);
        return new Promise((_, rej) =>
          hang.push(() => rej(new Error("cancelled"))),
        );
      }
      installs.push(target);
      if (opts.installFails) throw new Error(opts.installFails);
      // 入れたので、次からは kisui がある
      opts.serverIds.splice(0, opts.serverIds.length, "A");
      n = 0;
      return { path: "p", asset: "a", sha256: "h" };
    },
    onAskpassDone: async () => () => {},
  };
  return {
    api,
    sent,
    installs,
    cancels,
    installIds,
    hang,
    emit,
    /** ssh が切れた */
    drop(id: string) {
      closeds.forEach((f) => f({ id, code: 255, stderr: "" }));
    },
    get connects() {
      return n;
    },
  };
}

const fast = { delays: [5], pingIntervalMs: 1000, pingTimeoutMs: 1000 };

function waitFor(
  s: Session,
  pred: (st: SessionState) => boolean,
): Promise<SessionState> {
  return new Promise((resolve, reject) => {
    if (pred(s.state)) return resolve(s.state);
    const t = setTimeout(
      () => reject(new Error(`timeout; state=${JSON.stringify(s.state)}`)),
      2000,
    );
    const off = s.onState((st) => {
      if (pred(st)) {
        clearTimeout(t);
        off();
        resolve(st);
      }
    });
  });
}

const connectedId = (f: ReturnType<typeof fakeShell>) =>
  f.sent.filter((x) => x.msg.method === "session.hello").at(-1)!.id;

describe("Session", () => {
  it("切れたら resume を付けてつなぎ直す", async () => {
    const f = fakeShell({ serverIds: ["A", "A"] });
    const s = new Session(f.api, "h", fast);
    s.start();
    await waitFor(s, (st) => st.kind === "connected");

    const states: string[] = [];
    s.onState((st) => states.push(st.kind));
    f.drop(connectedId(f));
    await waitFor(s, (st) => st.kind === "reconnecting");
    await waitFor(s, (st) => st.kind === "connected");
    await new Promise((r) => setTimeout(r, 10));

    const hellos = f.sent.filter((x) => x.msg.method === "session.hello");
    assert.equal(hellos[0].msg.params.resume, undefined);
    assert.deepEqual(hellos[1].msg.params.resume, { serverId: "A", rev: 3 });
    assert.ok(states.includes("reconnecting"));
    await s.close();
  });

  it("serverId が違えば、ワークスペースの一覧から取り直す", async () => {
    const f = fakeShell({ serverIds: ["A", "B"] });
    const s = new Session(f.api, "h", fast);
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    f.drop(connectedId(f));
    await waitFor(s, (st) => st.kind === "reconnecting");
    await waitFor(s, (st) => st.kind === "connected");
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(s.workspaces, [{ id: "w-B" }]);
    await s.close();
  });

  it("回数を使い切ったら failed になり、retry で数え直す", async () => {
    const f = fakeShell({ serverIds: ["fail"] });
    const s = new Session(f.api, "h", { ...fast, maxAttempts: 3 });
    s.start();
    const st = await waitFor(s, (x) => x.kind === "failed");
    assert.match((st as { message: string }).message, /refused/);
    assert.equal(f.connects, 3);
    s.retry();
    await waitFor(s, (x) => x.kind === "failed");
    assert.equal(f.connects, 6);
  });

  it("ping の返事が来なければ切れたとみなしてつなぎ直す", async () => {
    let silent = true;
    const f = fakeShell({
      serverIds: ["A"],
      pingReply: () => !silent,
    });
    const s = new Session(f.api, "h", {
      delays: [5],
      pingIntervalMs: 20,
      pingTimeoutMs: 20,
    });
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    await waitFor(s, (st) => st.kind === "reconnecting");
    silent = false;
    await waitFor(s, (st) => st.kind === "connected");
    assert.ok(f.connects >= 2);
    await s.close();
  });

  it("別の GUI に引き継がれたら、つなぎ直さない", async () => {
    const f = fakeShell({ serverIds: ["A", "A"] });
    const s = new Session(f.api, "h", fast);
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    const id = connectedId(f);
    f.emit(id, {
      jsonrpc: "2.0",
      method: "session.superseded",
      params: { by: { client: {}, connectedAt: "t" } },
    });
    f.drop(id);
    await waitFor(s, (st) => st.kind === "superseded");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(f.connects, 1);
  });

  it("session.superseded を受けたら、shj が閉じ損ねても閉じて、引き継いだ GUI を状態に載せる", async () => {
    const f = fakeShell({ serverIds: ["A", "A"] });
    const s = new Session(f.api, "h", fast);
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    const by = {
      client: { name: "shijimi-editor-gui", version: "2", kind: "web" },
      connectedAt: "2026-11-01T10:00:00Z",
    };
    f.emit(connectedId(f), {
      jsonrpc: "2.0",
      method: "session.superseded",
      params: { by },
    });
    const st = await waitFor(s, (x) => x.kind === "superseded");
    assert.deepEqual(st, { kind: "superseded", by });
    assert.equal(s.connection, undefined);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(f.connects, 1, "自動では取り返さない");
  });

  it("引き継がれた後に retry すると、resume を付けてつなぎ直す", async () => {
    const f = fakeShell({ serverIds: ["A", "A"] });
    const s = new Session(f.api, "h", fast);
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    await new Promise((r) => setTimeout(r, 10));
    f.emit(connectedId(f), {
      jsonrpc: "2.0",
      method: "session.superseded",
      params: { by: { client: {}, connectedAt: "t" } },
    });
    await waitFor(s, (st) => st.kind === "superseded");
    s.retry();
    await waitFor(s, (st) => st.kind === "connected");
    assert.equal(f.connects, 2);
    const hellos = f.sent.filter((x) => x.msg.method === "session.hello");
    assert.deepEqual(hellos[1].msg.params.resume, { serverId: "A", rev: 3 });
    await s.close();
  });

  it("ping に not_owner が返ったら、引き継がれたとみなして取り返さない", async () => {
    const f = fakeShell({
      serverIds: ["A", "A"],
      pingError: () => ({ code: -32002, message: "not owner" }),
    });
    const s = new Session(f.api, "h", {
      delays: [5],
      pingIntervalMs: 20,
      pingTimeoutMs: 1000,
    });
    s.start();
    const st = await waitFor(s, (x) => x.kind === "superseded");
    assert.deepEqual(st, { kind: "superseded" });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(f.connects, 1);
  });

  it("onWorkspaces は、つながったときと workspace.changed のあとに一覧を渡す", async () => {
    const f = fakeShell({ serverIds: ["A"] });
    const s = new Session(f.api, "h", fast);
    const seen: string[][] = [];
    s.onWorkspaces((ws) => seen.push(ws.map((w) => w.id)));
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    await new Promise((r) => setTimeout(r, 10));
    // hello の一覧と、フォーカスを尋ねた workspace.list の一覧
    assert.deepEqual(seen, [["w-A"], ["w-A"]]);
    f.emit(connectedId(f), {
      jsonrpc: "2.0",
      method: "workspace.changed",
      params: { removed: ["w-A"] },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen, [["w-A"], ["w-A"], []]);
    await s.close();
  });

  it("つながると workspace.list で shj のフォーカスを知り、フォーカス先が消えたら null にする", async () => {
    const f = fakeShell({ serverIds: ["A"], focus: "w-A" });
    const s = new Session(f.api, "h", fast);
    const seen: (string | null)[] = [];
    s.onFocus((id) => seen.push(id));
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.focus, "w-A");
    f.emit(connectedId(f), {
      jsonrpc: "2.0",
      method: "workspace.changed",
      params: { removed: ["w-A"] },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen, ["w-A", null]);
    await s.close();
  });

  it("focusWorkspace は workspace.focus を送り、受け付けられたらフォーカスを移す", async () => {
    const f = fakeShell({ serverIds: ["A"] });
    const s = new Session(f.api, "h", fast);
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.focus, null);
    assert.equal(
      await s.focusWorkspace("w-A"),
      "t-A",
      "最後に使ったターミナルを返す",
    );
    await new Promise((r) => setTimeout(r, 10));
    const sentFocus = f.sent.filter((x) => x.msg.method === "workspace.focus");
    assert.deepEqual(sentFocus.at(-1)!.msg.params, { id: "w-A" });
    assert.equal(s.focus, "w-A");

    await assert.rejects(s.focusWorkspace("nope"), /no such workspace/);
    assert.equal(s.focus, "w-A", "断られたらフォーカスは変えない");
    await s.close();
  });

  it("つながっていないときの focusWorkspace は投げる", async () => {
    const f = fakeShell({ serverIds: ["A"] });
    const s = new Session(f.api, "h", fast);
    await assert.rejects(s.focusWorkspace("w-A"), /つながっていません/);
  });
});

describe("待ち時間と閉じる", () => {
  it("一度もつながっていないうちは connecting のまま、retryNow で待ちを飛ばす", async () => {
    const f = fakeShell({ serverIds: ["fail", "A"] });
    const s = new Session(f.api, "h", { ...fast, delays: [60000] });
    s.start();
    const w = await waitFor(
      s,
      (st) => st.kind === "connecting" && st.retryAt !== undefined,
    );
    assert.equal((w as { attempt: number }).attempt, 2);
    s.retryNow();
    await waitFor(s, (st) => st.kind === "connected");
    assert.equal(f.connects, 2);
    await s.close();
  });

  it("待っている最中に close すると、それ以上つなぎに行かない", async () => {
    const f = fakeShell({ serverIds: ["fail"] });
    const s = new Session(f.api, "h", { ...fast, delays: [30] });
    s.start();
    await waitFor(s, (st) => st.kind === "connecting" && !!st.retryAt);
    await s.close();
    const n = f.connects;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(f.connects, n);
    assert.equal(s.state.kind, "closed");
  });
});

describe("プライマリの shj の欄（#553）", () => {
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it("プライマリの shj が欄を出した・隠した知らせを渡す（pane.show・pane.hide）", async () => {
    const f = fakeShell({ serverIds: ["A"] });
    const s = new Session(f.api, "h", fast);
    const got: unknown[] = [];
    s.onPane((e) => got.push(e));
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    const id = connectedId(f);
    f.emit(id, {
      jsonrpc: "2.0",
      method: "pane.show",
      params: { workspaceId: "w1", termId: "t2" },
    });
    f.emit(id, {
      jsonrpc: "2.0",
      method: "pane.hide",
      params: { workspaceId: "w1" },
    });
    f.emit(id, { jsonrpc: "2.0", method: "pane.show", params: {} });
    await settle();
    assert.deepEqual(got, [
      { kind: "show", workspaceId: "w1", termId: "t2" },
      { kind: "hide", workspaceId: "w1" },
    ]);
    await s.close();
  });

  it("プライマリの shj が動画の欄を出した知らせを渡す（pane.show の extraId）", async () => {
    const f = fakeShell({ serverIds: ["A"] });
    const s = new Session(f.api, "h", fast);
    const got: unknown[] = [];
    s.onPane((e) => got.push(e));
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    const id = connectedId(f);
    f.emit(id, {
      jsonrpc: "2.0",
      method: "pane.show",
      params: { workspaceId: "w1", extraId: "x3" },
    });
    await settle();
    assert.deepEqual(got, [
      { kind: "show-extra", workspaceId: "w1", extraId: "x3" },
    ]);
    await s.close();
  });
});

describe("applyWorkspaceChange", () => {
  it("追加・更新・削除を当てる", () => {
    const w = (id: string, name = id) => ({ id, name }) as never;
    const r = applyWorkspaceChange([w("a"), w("b")], {
      added: [w("c")],
      updated: [w("a", "A")],
      removed: ["b"],
    });
    assert.deepEqual(r, [w("a", "A"), w("c")]);
  });
});

describe("kisui が無いリモート", () => {
  it("つなぎ直さず、聞く段階で止まる。ユーザーが答えるまで何も入れない", async () => {
    const f = fakeShell({ serverIds: ["missing"] });
    const s = new Session(f.api, "h", fast);
    s.start();
    const st = await waitFor(s, (x) => x.kind === "needs-install");
    assert.equal(st.kind === "needs-install" && st.plan.version, "0.0.0");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(f.connects, 1, "つなぎ直しを繰り返さない");
    assert.deepEqual(f.installs, [], "聞く前に入れない");
    await s.close();
  });

  it("入れると答えたら入れて、つなぎ直して connected になる", async () => {
    const f = fakeShell({ serverIds: ["missing"] });
    const s = new Session(f.api, "h", fast);
    s.start();
    await waitFor(s, (x) => x.kind === "needs-install");
    const done = s.install();
    assert.equal(s.state.kind, "installing");
    await done;
    await waitFor(s, (x) => x.kind === "connected");
    assert.deepEqual(f.installs, ["h"]);
    await s.close();
  });

  it("入れるのに失敗したら、理由付きで聞く段階に戻る（つながない）", async () => {
    const f = fakeShell({
      serverIds: ["missing"],
      installFails: "SHA-256 mismatch",
    });
    const s = new Session(f.api, "h", fast);
    s.start();
    await waitFor(s, (x) => x.kind === "needs-install");
    await s.install();
    assert.ok(
      s.state.kind === "needs-install" &&
        s.state.error?.includes("SHA-256 mismatch"),
    );
    assert.equal(f.connects, 1);
    await s.close();
  });

  it("入れないと答えたら何も入れず failed。つなぎ直すと、もう一度聞く", async () => {
    const f = fakeShell({ serverIds: ["missing"] });
    const s = new Session(f.api, "h", fast);
    s.start();
    await waitFor(s, (x) => x.kind === "needs-install");
    s.declineInstall();
    assert.equal(s.state.kind, "failed");
    assert.deepEqual(f.installs, []);
    s.retry();
    await waitFor(s, (x) => x.kind === "needs-install");
    assert.deepEqual(f.installs, []);
    await s.close();
  });

  it("聞く段階以外では install() は何もしない", async () => {
    const f = fakeShell({ serverIds: ["A"] });
    const s = new Session(f.api, "h", fast);
    s.start();
    await waitFor(s, (x) => x.kind === "connected");
    await s.install();
    assert.deepEqual(f.installs, []);
    await s.close();
  });
});

describe("入れている最中に切る", () => {
  it("close() が askpass の質問を取り消す", async () => {
    const f = fakeShell({ serverIds: ["missing"], installHangs: true });
    const s = new Session(f.api, "h", fast);
    s.start();
    await waitFor(s, (x) => x.kind === "needs-install");
    void s.install();
    assert.equal(s.state.kind, "installing");
    await s.close();
    assert.deepEqual(f.cancels, f.installIds);
    assert.equal(f.cancels.length, 1);
    f.hang.forEach((h) => h());
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.state.kind, "closed", "取り消しの失敗で状態を戻さない");
  });
});

describe("Session のツリー", () => {
  it("request は今の接続に送り、tree.changed と git.changed はつなぎ直しても届く", async () => {
    const f = fakeShell({ serverIds: ["A"] });
    const s = new Session(f.api, "h", fast);
    await assert.rejects(
      s.request("tree.watch", { workspaceId: "w", paths: [] }),
    );
    const trees: string[][] = [];
    const gits: number[] = [];
    s.onTreeChanged((n) => trees.push(n.paths));
    s.onGitChanged((n) => gits.push(n.rev));
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    assert.deepEqual(
      await s.request("tree.watch", { workspaceId: "w-A", paths: [""] }),
      {},
    );
    f.emit(connectedId(f), {
      jsonrpc: "2.0",
      method: "tree.changed",
      params: { workspaceId: "w-A", paths: [""], rev: 2 },
    });
    f.drop(connectedId(f));
    await waitFor(s, (st) => st.kind === "reconnecting");
    await waitFor(s, (st) => st.kind === "connected");
    f.emit(connectedId(f), {
      jsonrpc: "2.0",
      method: "git.changed",
      params: { workspaceId: "w-A", rev: 5 },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(trees, [[""]]);
    assert.deepEqual(gits, [5]);
    await s.close();
  });
});
