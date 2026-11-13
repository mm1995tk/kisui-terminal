import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AttachInfo, HelloResult } from "../rpc/protocol.ts";
import type { ClosedEvent, ShellApi } from "./api.ts";
import {
  applyWorkspaceChange,
  needsHandover,
  Session,
  type SessionState,
} from "./session.ts";

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
  /** kisui attach が目印のあとに名乗る自分の kisui（attach.info） */
  attach?: AttachInfo;
  /** serve の版。既定は version "1"・commit "x" */
  shj?: { version: string; commit: string };
  /** hello の capabilities */
  capabilities?: string[];
  /**
   * server.handover への答え。"ok" なら返事をして接続を閉じ、serve の版を attach の版にする。
   * エラーなら断る（serve の版は変わらない）。"drop" なら返事をせずに接続を閉じる、"silent" なら何も返さない
   */
  handover?: "ok" | "drop" | "silent" | { code: number; message: string };
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
  let shj = opts.shj ?? { version: "1", commit: "x" };
  const emit = (id: string, obj: unknown) =>
    lines.forEach((f) => f({ id, line: JSON.stringify(obj) }));
  const api: ShellApi = {
    listSshHosts: async () => [],
    configMachines: async () => [],
    configMoved: async () => false,
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
      if (opts.attach)
        emit(id, {
          jsonrpc: "2.0",
          method: "attach.info",
          params: opts.attach,
        });
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
            shj: { ...shj, channel: "stable" },
            serverId: serverOf.get(id),
            startedAt: "now",
            capabilities: opts.capabilities ?? [],
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
        case "server.handover": {
          const h = opts.handover ?? "ok";
          if (h === "silent") {
            // 返事をしない（GUI の時間切れ）
          } else if (h === "drop") {
            queueMicrotask(() =>
              closeds.forEach((f) => f({ id, code: 0, stderr: "" })),
            );
          } else if (h === "ok") {
            reply({ pid: 42 });
            // 古い serve は返事のあと接続を閉じる。新しい serve は attach と同じ版
            if (opts.attach)
              shj = {
                version: opts.attach.version,
                commit: opts.attach.commit,
              };
            setTimeout(() =>
              closeds.forEach((f) => f({ id, code: 0, stderr: "" })),
            );
          } else {
            queueMicrotask(() =>
              emit(id, { jsonrpc: "2.0", id: msg.id, error: h }),
            );
          }
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
      path: "~/.cache/kisui-terminal/0.0.0/kisui",
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

  it("別の kisui-terminal に引き継がれたら、つなぎ直さない", async () => {
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

  it("session.superseded を受けたら、shj が閉じ損ねても閉じて、引き継いだ kisui-terminal を状態に載せる", async () => {
    const f = fakeShell({ serverIds: ["A", "A"] });
    const s = new Session(f.api, "h", fast);
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    const by = {
      client: { name: "kisui-terminal", version: "2", kind: "web" },
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

  it("URL を外部ブラウザで開く頼みを渡す（browser.open）", async () => {
    const f = fakeShell({ serverIds: ["A"] });
    const s = new Session(f.api, "h", fast);
    const got: unknown[] = [];
    s.onPane((e) => got.push(e));
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    const id = connectedId(f);
    f.emit(id, {
      jsonrpc: "2.0",
      method: "browser.open",
      params: { workspaceId: "w1", url: "http://localhost:3000/" },
    });
    f.emit(id, {
      jsonrpc: "2.0",
      method: "browser.open",
      params: { workspaceId: "w1" },
    });
    await settle();
    assert.deepEqual(got, [
      { kind: "open-url", workspaceId: "w1", url: "http://localhost:3000/" },
    ]);
    await s.close();
  });

  it("kisui update の update.check を渡し、答えを update.result で送る（#94）", async () => {
    const f = fakeShell({ serverIds: ["A"] });
    const s = new Session(f.api, "h", fast);
    const got: unknown[] = [];
    s.onPane((e) => got.push(e));
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    const id = connectedId(f);
    f.emit(id, {
      jsonrpc: "2.0",
      method: "update.check",
      params: { id: "u1" },
    });
    f.emit(id, { jsonrpc: "2.0", method: "update.check", params: {} });
    await settle();
    assert.deepEqual(got, [{ kind: "update-check", id: "u1" }]);
    s.reportUpdate("u1", { status: "latest", current: "0.1.0" });
    await settle();
    const sent = f.sent.filter((x) => x.msg.method === "update.result");
    assert.deepEqual(
      sent.map((x) => x.msg.params),
      [{ id: "u1", status: "latest", current: "0.1.0" }],
    );
    await s.close();
  });

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

  it("ファイルエクスプローラへのフォーカスの頼みを渡す（explorer.focus）。workspaceId が無ければ捨てる", async () => {
    const f = fakeShell({ serverIds: ["A"] });
    const s = new Session(f.api, "h", fast);
    const got: unknown[] = [];
    s.onPane((e) => got.push(e));
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    const id = connectedId(f);
    f.emit(id, {
      jsonrpc: "2.0",
      method: "explorer.focus",
      params: { workspaceId: "w1" },
    });
    f.emit(id, { jsonrpc: "2.0", method: "explorer.focus", params: {} });
    await settle();
    assert.deepEqual(got, [{ kind: "explorer", workspaceId: "w1" }]);
    await s.close();
  });

  it("explorer.focus の start（shj の起動直後）は start 付きで渡す", async () => {
    const f = fakeShell({ serverIds: ["A"] });
    const s = new Session(f.api, "h", fast);
    const got: unknown[] = [];
    s.onPane((e) => got.push(e));
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    const id = connectedId(f);
    f.emit(id, {
      jsonrpc: "2.0",
      method: "explorer.focus",
      params: { workspaceId: "w1", start: true },
    });
    await settle();
    assert.deepEqual(got, [
      { kind: "explorer", workspaceId: "w1", start: true },
    ]);
    await s.close();
  });

  it("CHANGES へのフォーカスの頼みを渡す（changes.focus）。workspaceId が無ければ捨てる", async () => {
    const f = fakeShell({ serverIds: ["A"] });
    const s = new Session(f.api, "h", fast);
    const got: unknown[] = [];
    s.onPane((e) => got.push(e));
    s.start();
    await waitFor(s, (st) => st.kind === "connected");
    const id = connectedId(f);
    f.emit(id, {
      jsonrpc: "2.0",
      method: "changes.focus",
      params: { workspaceId: "w1" },
    });
    f.emit(id, { jsonrpc: "2.0", method: "changes.focus", params: {} });
    await settle();
    assert.deepEqual(got, [{ kind: "changes", workspaceId: "w1" }]);
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

describe("新しい版の kisui serve への切り替え（#8）", () => {
  const attach: AttachInfo = {
    executable: "/opt/kisui-2/kisui",
    version: "2",
    commit: "y",
    channel: "stable",
    env: { KISUI_SHJ_DIR: "/opt/kisui-2/shj" },
  };
  const handovers = (f: ReturnType<typeof fakeShell>) =>
    f.sent.filter((x) => x.msg.method === "server.handover");

  it("serve の版が attach と違えば、聞かずに server.handover を頼み、resume でつなぎ直す", async () => {
    const f = fakeShell({
      serverIds: ["A"],
      attach,
      capabilities: ["server.handover"],
    });
    const s = new Session(f.api, "h", fast);
    const states: SessionState[] = [];
    s.onState((st) => states.push(st));
    s.start();
    const st = await waitFor(
      s,
      (x) => x.kind === "connected" && x.hello.shj.version === "2",
    );
    assert.equal((st as { handoverError?: string }).handoverError, undefined);
    assert.deepEqual(
      handovers(f).map((x) => x.msg.params),
      [{ executable: attach.executable, env: attach.env }],
    );
    // 切り替えている間は switching が付き、古い serve では connected にならない
    assert.ok(
      states.some((x) => x.kind === "connecting" && x.switching === true),
    );
    assert.equal(states.filter((x) => x.kind === "connected").length, 1);
    const hellos = f.sent.filter((x) => x.msg.method === "session.hello");
    assert.equal(hellos.length, 2);
    assert.deepEqual(hellos[1].msg.params.resume, { serverId: "A", rev: 3 });
    await s.close();
  });

  it("切り替えが断られたら、古い serve のまま connected になり、理由を持つ", async () => {
    const f = fakeShell({
      serverIds: ["A"],
      attach,
      capabilities: ["server.handover"],
      handover: { code: -32603, message: "new serve: exec format error" },
    });
    const s = new Session(f.api, "h", fast);
    s.start();
    const st = await waitFor(s, (x) => x.kind === "connected");
    assert.equal(st.kind, "connected");
    if (st.kind !== "connected") return;
    assert.equal(st.hello.shj.version, "1");
    assert.match(st.handoverError ?? "", /exec format error/);
    // 古い serve のまま使える
    assert.deepEqual(
      await s.request("tree.watch", { workspaceId: "w-A", paths: [""] }),
      {},
    );
    // 切れてつなぎ直しても、もう一度は頼まない
    f.drop(connectedId(f));
    await waitFor(s, (x) => x.kind === "reconnecting");
    await waitFor(s, (x) => x.kind === "connected");
    assert.equal(handovers(f).length, 1);
    assert.equal(f.connects, 2);
    await s.close();
  });

  it("返事の前に切れたら、普通のつなぎ直しになり、もう一度は頼まない", async () => {
    const f = fakeShell({
      serverIds: ["A"],
      attach,
      capabilities: ["server.handover"],
      handover: "drop",
    });
    const s = new Session(f.api, "h", fast);
    s.start();
    const st = await waitFor(s, (x) => x.kind === "connected");
    assert.equal(st.kind === "connected" && st.handoverError, undefined);
    assert.equal(handovers(f).length, 1);
    assert.equal(f.connects, 2);
    await s.close();
  });

  it("返事が来ないまま時間切れになったら、切り替え中の表示を外して普通のつなぎ直しになる", async () => {
    const f = fakeShell({
      serverIds: ["A"],
      attach,
      capabilities: ["server.handover"],
      handover: "silent",
    });
    const s = new Session(f.api, "h", { ...fast, handoverTimeoutMs: 20 });
    const states: SessionState[] = [];
    s.onState((st) => states.push(st));
    s.start();
    const st = await waitFor(s, (x) => x.kind === "connected");
    assert.equal(st.kind === "connected" && st.hello.shj.version, "1");
    assert.equal(st.kind === "connected" && st.handoverError, undefined);
    assert.equal(handovers(f).length, 1);
    assert.equal(f.connects, 2);
    // 時間切れのあとのつなぎ直しには switching が付かない
    const after = states.filter(
      (x) =>
        (x.kind === "connecting" || x.kind === "reconnecting") &&
        /timed out/.test(x.reason ?? ""),
    );
    assert.ok(after.length > 0);
    assert.ok(
      after.every(
        (x) =>
          (x.kind === "connecting" || x.kind === "reconnecting") &&
          x.switching === undefined,
      ),
    );
    await s.close();
  });

  it("版が同じ・serve が server.handover を持たない・attach が名乗らないときは頼まない", async () => {
    for (const o of [
      {
        attach: { ...attach, version: "1", commit: "x" },
        capabilities: ["server.handover"],
      },
      { attach, capabilities: [] },
      { capabilities: ["server.handover"] },
    ]) {
      const f = fakeShell({ serverIds: ["A"], ...o });
      const s = new Session(f.api, "h", fast);
      s.start();
      await waitFor(s, (x) => x.kind === "connected");
      assert.equal(handovers(f).length, 0);
      await s.close();
    }
  });
});

describe("needsHandover", () => {
  const hello = (version: string, commit: string, caps = ["server.handover"]) =>
    ({
      shj: { version, commit, channel: "nightly" },
      capabilities: caps,
    }) as unknown as HelloResult;
  const a = (version: string, commit: string): AttachInfo => ({
    executable: "/k",
    version,
    commit,
    channel: "nightly",
  });

  it("version か commit が違えば切り替える（nightly どうしは commit で見分ける）", () => {
    assert.equal(
      needsHandover({
        hello: hello("0.2.0", "abc"),
        attach: a("0.2.0", "abc"),
      }),
      false,
    );
    assert.equal(
      needsHandover({
        hello: hello("0.2.0", "abc"),
        attach: a("0.2.0", "def"),
      }),
      true,
    );
    assert.equal(
      needsHandover({
        hello: hello("0.1.0", "abc"),
        attach: a("0.2.0", "abc"),
      }),
      true,
    );
    assert.equal(
      needsHandover({
        hello: hello("0.1.0", "abc", []),
        attach: a("0.2.0", "abc"),
      }),
      false,
    );
    assert.equal(needsHandover({ hello: hello("0.1.0", "abc") }), false);
  });
});
