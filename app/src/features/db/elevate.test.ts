import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { T } from "../../i18n/index.ts";
import { ErrorCode, RpcError } from "../../infrastructure/rpc/message.ts";
import type { DbConnection } from "../../infrastructure/rpc/protocol.ts";
import type { Session } from "../sessions/session.ts";
import type { DbRef } from "../workspaces/model.ts";
import {
  durationText,
  elevateFailure,
  elevateRows,
  elevationsOf,
  elevationTexts,
  remainingSeconds,
  remainingText,
} from "./elevate.ts";
import { createDbElevate } from "./elevateController.ts";
import { dbElevateKey } from "./keys.ts";

const conn = (over: Partial<DbConnection> = {}): DbConnection => ({
  name: "shop",
  variant: "prod",
  kind: "postgres",
  host: "db.example.com",
  port: 5432,
  user: "app",
  database: "shop",
  readOnly: true,
  human: {
    permission: "reader",
    run: "read",
    elevate: { to: "free", run: "free", maxSeconds: 1800 },
  },
  agent: { permission: "off", run: "none", propose: true, user: "app" },
  ...over,
});

/** 人の権限を free に強めている接続（残り seconds 秒）。 */
const elevatedConn = (seconds: number): DbConnection =>
  conn({
    readOnly: false,
    human: {
      permission: "free",
      run: "free",
      elevate: { to: "free", run: "free", maxSeconds: 1800 },
      elevated: {
        from: "reader",
        until: "2026-01-02T03:04:05Z",
        remainingSeconds: seconds,
      },
    },
  });

describe("時間の字", () => {
  it("durationText は kisui serve が読む書き方（0 の単位は書かない）", () => {
    assert.equal(durationText(1800), "30m");
    assert.equal(durationText(3600), "1h");
    assert.equal(durationText(5400), "1h30m");
    assert.equal(durationText(90), "1m30s");
    assert.equal(durationText(3605), "1h5s");
    assert.equal(durationText(0), "0s");
  });

  it("remainingText は 1 分より短ければ秒、長ければ分に切り上げる", () => {
    assert.equal(remainingText(45), "45s");
    assert.equal(remainingText(60), "1m");
    assert.equal(remainingText(61), "2m");
    assert.equal(remainingText(725), "13m");
    assert.equal(remainingText(3601), "1h1m");
    assert.equal(remainingText(-5), "0s");
  });

  it("remainingSeconds は切り上げ、過ぎていれば 0", () => {
    assert.equal(remainingSeconds(10_000, 9_001), 1);
    assert.equal(remainingSeconds(10_000, 4_000), 6);
    assert.equal(remainingSeconds(10_000, 10_000), 0);
    assert.equal(remainingSeconds(10_000, 12_000), 0);
  });
});

describe("強められる権限と、強めている権限", () => {
  it("elevateRows は、強められるものだけを人・エージェントの順に", () => {
    assert.deepEqual(elevateRows(conn()), [
      {
        actor: "human",
        from: "reader",
        to: "free",
        run: "free",
        maxSeconds: 1800,
      },
    ]);
    const both = conn({
      agent: {
        permission: "off",
        run: "none",
        propose: true,
        user: "app",
        elevate: { to: "reader", run: "read", maxSeconds: 600 },
      },
    });
    assert.deepEqual(
      elevateRows(both).map((r) => r.actor),
      ["human", "agent"],
    );
    // 権限を知らない古い kisui serve の接続（human・agent が無い）
    assert.deepEqual(
      elevateRows(conn({ human: undefined, agent: undefined })),
      [],
    );
  });

  it("強めている間の行は、元の権限の名前と残りの時間を持つ", () => {
    assert.deepEqual(elevateRows(elevatedConn(100)), [
      {
        actor: "human",
        from: "reader",
        to: "free",
        run: "free",
        maxSeconds: 1800,
        remainingSeconds: 100,
      },
    ]);
  });

  it("elevationsOf は、残りの時間を窓の時計の時刻にする", () => {
    assert.deepEqual(elevationsOf(conn(), 1000), []);
    assert.deepEqual(elevationsOf(elevatedConn(100), 1000), [
      { actor: "human", permission: "free", deadline: 101_000 },
    ]);
  });

  it("elevationTexts は、誰の権限を・何に・残りどれだけ", () => {
    assert.deepEqual(
      elevationTexts(elevationsOf(elevatedConn(100), 1000), 41_000),
      [
        T("db.elevate.badge", {
          who: T("db.elevate.human"),
          permission: "free",
          time: "1m",
        }),
      ],
    );
  });
});

describe("db.elevate の断りの文", () => {
  const err = (code: number, data?: unknown) =>
    new RpcError({ code, message: "raw", ...(data ? { data } : {}) });

  it("上限を超えた・強められない・時間の書き方・接続が無い", () => {
    assert.equal(
      elevateFailure(
        err(ErrorCode.Denied, { reason: "over_max", maxSeconds: 1800 }),
      ),
      T("db.elevate.err.overMax", { max: "30m" }),
    );
    assert.equal(
      elevateFailure(err(ErrorCode.Denied, { reason: "not_elevatable" })),
      T("db.elevate.err.notElevatable"),
    );
    assert.equal(
      elevateFailure(err(ErrorCode.InvalidParams)),
      T("db.elevate.err.time"),
    );
    assert.equal(
      elevateFailure(err(ErrorCode.NotFound)),
      T("db.err.noConnection"),
    );
  });

  it("ほかは、相手の文のまま", () => {
    assert.equal(elevateFailure(err(ErrorCode.Denied)), "raw");
    assert.equal(elevateFailure(new Error("boom")), "boom");
  });
});

describe("強める窓のキー", () => {
  const key = (key: string, mod: Partial<KeyboardEvent> = {}) =>
    ({ key, ...mod }) as KeyboardEvent;

  it("↓ ↑・Ctrl+J / Ctrl+K で選び、Enter で強める。字と ? は入力欄へ", () => {
    assert.deepEqual(dbElevateKey(key("ArrowDown")), { kind: "step", step: 1 });
    assert.deepEqual(dbElevateKey(key("k", { ctrlKey: true })), {
      kind: "step",
      step: -1,
    });
    assert.deepEqual(dbElevateKey(key("Enter")), { kind: "choose" });
    assert.equal(dbElevateKey(key("j")), null);
    assert.equal(dbElevateKey(key("?")), null);
  });

  it("かな漢字変換を確定する Enter は受けない", () => {
    assert.equal(dbElevateKey(key("Enter", { isComposing: true })), null);
  });
});

describe("強める操作（elevateController）", () => {
  const ref: DbRef = {
    kind: "db",
    id: "d1",
    target: "a",
    connection: "shop",
    variant: "prod",
  };

  function setup(
    opts: { supported?: "yes" | "no" | "unknown"; current?: DbConnection } = {},
  ) {
    let current: DbConnection | undefined = opts.current ?? conn();
    let time = 1_000_000;
    let tickFn: (() => void) | undefined;
    const sent: { method: string; params: unknown }[] = [];
    const toasts: string[] = [];
    const fails: [string, string][] = [];
    let focused = 0;
    let elevateError: unknown;
    let supported = opts.supported ?? "yes";
    const session = {
      request: async (method: string, params: unknown) => {
        sent.push({ method, params });
        if (method === "db.connections")
          return { connections: current ? [current] : [], problems: [] };
        if (method === "db.elevate") {
          if (elevateError) throw elevateError;
          current = elevatedConn(600);
          return { connection: current };
        }
        if (method === "db.elevateEnd") {
          current = conn();
          return { connection: current };
        }
        throw new Error(`unexpected ${method}`);
      },
    } as unknown as Session;
    const e = createDbElevate({
      refOf: (id) => (id === ref.id ? ref : undefined),
      sessionFor: () => session,
      supported: () => supported,
      showToast: (t) => toasts.push(t),
      fail: (title, text) => fails.push([title, text]),
      focusTerminal: () => {
        focused++;
      },
      now: () => time,
      startClock: (tick) => {
        tickFn = tick;
        return () => {
          tickFn = undefined;
        };
      },
    });
    return {
      e,
      sent,
      toasts,
      fails,
      focused: () => focused,
      methods: () => sent.map((s) => s.method),
      advance: (ms: number) => {
        time += ms;
        tickFn?.();
      },
      clockRunning: () => tickFn !== undefined,
      setCurrent: (c: DbConnection | undefined) => {
        current = c;
      },
      setSupported: (v: "yes" | "no" | "unknown") => {
        supported = v;
      },
      failElevate: (err: unknown) => {
        elevateError = err;
      },
    };
  }
  /** 約束が進むのを待つ。 */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("窓を出し、強める：打った時間をそのまま送り、窓を閉じて知らせ、残りの時間を出す", async () => {
    const s = setup();
    await s.e.openElevate("d1");
    assert.deepEqual(
      s.e.elevateAsk()?.rows?.map((r) => r.actor),
      ["human"],
    );
    assert.deepEqual(s.e.elevatedOf("d1"), []);
    await s.e.submitElevate("human", " 10m ");
    assert.deepEqual(s.sent.at(-1), {
      method: "db.elevate",
      params: {
        connection: "shop",
        variant: "prod",
        actor: "human",
        duration: "10m",
      },
    });
    assert.equal(s.e.elevateAsk(), null);
    assert.equal(s.focused(), 1);
    assert.deepEqual(s.toasts, [
      T("db.elevate.done", {
        who: T("db.elevate.human"),
        permission: "free",
        time: "10m",
      }),
    ]);
    assert.deepEqual(s.e.elevatedOf("d1"), [
      T("db.elevate.badge", {
        who: T("db.elevate.human"),
        permission: "free",
        time: "10m",
      }),
    ]);
    assert.equal(s.clockRunning(), true);
  });

  it("残りの時間は時計で減り、過ぎたら外して kisui serve に聞き直す", async () => {
    const s = setup();
    await s.e.openElevate("d1");
    await s.e.submitElevate("human", "10m");
    s.advance(9 * 60_000 + 30_000);
    assert.deepEqual(s.e.elevatedOf("d1"), [
      T("db.elevate.badge", {
        who: T("db.elevate.human"),
        permission: "free",
        time: "30s",
      }),
    ]);
    s.setCurrent(conn());
    const before = s.sent.length;
    s.advance(30_000);
    assert.deepEqual(s.e.elevatedOf("d1"), []);
    await settle();
    assert.deepEqual(s.methods().slice(before), ["db.connections"]);
    assert.equal(s.clockRunning(), false);
  });

  it("断られたら、理由を窓に出して開いたままにする", async () => {
    const s = setup();
    await s.e.openElevate("d1");
    s.failElevate(
      new RpcError({
        code: ErrorCode.Denied,
        message: "raw",
        data: { reason: "over_max", maxSeconds: 1800 },
      }),
    );
    await s.e.submitElevate("human", "2h");
    assert.equal(
      s.e.elevateAsk()?.error,
      T("db.elevate.err.overMax", { max: "30m" }),
    );
    assert.equal(s.e.elevateAsk()?.rows?.length, 1);
    assert.deepEqual(s.toasts, []);
    assert.deepEqual(s.e.elevatedOf("d1"), []);
  });

  it("強められる権限が無ければ、窓を出さずに理由を伝える", async () => {
    const s = setup({
      current: conn({ human: { permission: "reader", run: "read" } }),
    });
    await s.e.openElevate("d1");
    assert.equal(s.e.elevateAsk(), null);
    assert.deepEqual(s.fails, [
      [T("cannot.dbElevate.title"), T("cannot.dbElevate.none")],
    ]);
  });

  it("古い kisui serve には頼まずに、理由を伝える", async () => {
    const s = setup({ supported: "no" });
    await s.e.openElevate("d1");
    await s.e.endElevation("d1");
    assert.deepEqual(s.sent, []);
    assert.deepEqual(s.fails, [
      [T("cannot.dbElevate.title"), T("cannot.dbElevate.old")],
      [T("cannot.dbElevate.title"), T("cannot.dbElevate.old")],
    ]);
  });

  it("元に戻す：強めているものを全部戻して知らせる。無ければ、その旨を伝える", async () => {
    const s = setup({ current: elevatedConn(600) });
    await s.e.refreshElevation(ref);
    assert.equal(s.e.elevatedOf("d1").length, 1);
    await s.e.endElevation("d1");
    assert.deepEqual(s.sent.at(-1), {
      method: "db.elevateEnd",
      params: { connection: "shop", variant: "prod", actor: "human" },
    });
    assert.deepEqual(s.toasts, [
      T("db.elevate.ended", { who: T("db.elevate.human") }),
    ]);
    assert.deepEqual(s.e.elevatedOf("d1"), []);
    assert.equal(s.clockRunning(), false);
    await s.e.endElevation("d1");
    assert.deepEqual(s.fails, [
      [T("cannot.dbElevateEnd.title"), T("cannot.dbElevateEnd.none")],
    ]);
  });

  it("つながっていない間に聞き直すと、強めていないことにする（kisui serve には聞かない）", async () => {
    const s = setup({ current: elevatedConn(600) });
    await s.e.refreshElevation(ref);
    assert.equal(s.e.elevatedOf("d1").length, 1);
    s.setSupported("unknown");
    const before = s.sent.length;
    await s.e.refreshElevation(ref);
    assert.deepEqual(s.e.elevatedOf("d1"), []);
    assert.equal(s.sent.length, before);
    assert.equal(s.clockRunning(), false);
  });

  it("DB のタブが残っていない接続の分は忘れる", async () => {
    const s = setup({ current: elevatedConn(600) });
    await s.e.refreshElevation(ref);
    s.e.forgetElevations(() => true);
    assert.equal(s.e.elevatedOf("d1").length, 1);
    s.e.forgetElevations(() => false);
    assert.deepEqual(s.e.elevatedOf("d1"), []);
    assert.equal(s.clockRunning(), false);
  });
});
