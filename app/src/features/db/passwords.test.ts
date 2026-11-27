import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ErrorCode, RpcError } from "../../infrastructure/rpc/message.ts";
import type {
  DbConnection,
  HelloResult,
  Requests,
} from "../../infrastructure/rpc/protocol.ts";
import { withPassword } from "./model.ts";
import {
  handBack,
  handBackAll,
  newlyConnected,
  passwordKeeper,
  PasswordMemory,
  passwordOwner,
  rememberParams,
  type PasswordOwner,
} from "./passwords.ts";

type RememberParams = Requests["db.remember"]["params"];

const conn = (over: Partial<DbConnection> = {}): DbConnection => ({
  name: "shop",
  variant: "",
  kind: "postgres",
  host: "db.example.com",
  port: 5432,
  user: "app",
  database: "shop",
  readOnly: false,
  ...over,
});

const owner = (
  target = "@local",
  over: Partial<DbConnection> = {},
): PasswordOwner => passwordOwner(target, conn(over));

const need = (
  reason: "missing" | "rejected",
  passwordSource?: "keychain" | "file",
) =>
  new RpcError({
    code: ErrorCode.PasswordRequired,
    message: "password required",
    data: { reason, ...(passwordSource ? { passwordSource } : {}) },
  });

/**
 * kisui serve の役。設定の接続は config（書き換えられる）。覚えたパスワードは kept で、forgetAll が、Window の接続が切れたときの
 * 「全部忘れる」。query はパスワードを付けない・付けた要求で、DB が通すのは right だけ。
 */
function fakeServe(right = "right") {
  const serve = {
    config: conn(),
    kept: undefined as string | undefined,
    remembers: [] as RememberParams[],
    queries: [] as (string | undefined)[],
    forgetAll() {
      serve.kept = undefined;
    },
    async remember(p: RememberParams) {
      serve.remembers.push(p);
      const c = serve.config;
      const same =
        p.connection === c.name &&
        (p.variant ?? "") === (c.variant ?? "") &&
        p.kind === c.kind &&
        p.host === c.host &&
        p.port === c.port &&
        p.user === c.user;
      if (same) serve.kept = p.password;
      return { remembered: same };
    },
    async query(password: string | undefined) {
      serve.queries.push(password);
      const used = password ?? serve.kept;
      if (used === undefined) throw need("missing");
      if (used !== right) {
        serve.kept = undefined;
        throw need("rejected");
      }
      serve.kept = used;
      return "rows";
    },
  };
  return serve;
}

/** Dialog の役：fakeServe に、タブ（@local の shop）の要求を送る。asked は、利用者に聞いた理由。answers は、その答え。 */
function fakeWindow(
  serve: ReturnType<typeof fakeServe>,
  answers: (string | null)[] = [],
) {
  const memory = new PasswordMemory();
  const place = { target: "@local", connection: "shop" };
  const asked: string[] = [];
  const keeper = passwordKeeper(memory, place, {
    owner: async () => passwordOwner("@local", serve.config),
    send: (p) => serve.remember(p),
  });
  return {
    memory,
    place,
    asked,
    request: () =>
      withPassword(
        (p) => serve.query(p),
        async (reason, source) => {
          asked.push(source ? `${reason}:${source}` : reason);
          const a = answers.shift();
          return a === undefined ? null : a;
        },
        keeper,
      ),
    reconnect: () => handBackAll(memory, "@local", (p) => serve.remember(p)),
  };
}

describe("PasswordMemory（打って通ったパスワードを、メモリにだけ覚える）", () => {
  it("マシン・接続の名前・変種ごとに覚え、同じ接続の前のものは置き換える", () => {
    const m = new PasswordMemory();
    m.remember(owner(), "one");
    m.remember(owner("@local", { variant: "prod" }), "two");
    m.remember(owner("ssh-host"), "three");
    assert.equal(
      m.find({ target: "@local", connection: "shop" })?.password,
      "one",
    );
    assert.equal(
      m.find({ target: "@local", connection: "shop", variant: "prod" })
        ?.password,
      "two",
    );
    assert.equal(
      m.find({ target: "ssh-host", connection: "shop" })?.password,
      "three",
    );
    assert.equal(m.find({ target: "@local", connection: "logs" }), undefined);
    m.remember(owner("@local", { host: "other.example.com" }), "four");
    const e = m.find({ target: "@local", connection: "shop" });
    assert.equal(e?.password, "four");
    assert.equal(e?.owner.host, "other.example.com");
    assert.deepEqual(
      m.of("@local").map((x) => x.password),
      ["four", "two"],
    );
    m.forget({ target: "@local", connection: "shop" });
    assert.equal(m.find({ target: "@local", connection: "shop" }), undefined);
  });

  it("drop は、その接続にもう別のものを覚えていれば、捨てない", () => {
    const m = new PasswordMemory();
    m.remember(owner(), "old");
    const old = m.find({ target: "@local", connection: "shop" })!;
    m.remember(owner(), "new");
    m.drop(old);
    assert.equal(
      m.find({ target: "@local", connection: "shop" })?.password,
      "new",
    );
  });
});

describe("handBack（覚えているパスワードを kisui serve に渡し直す）", () => {
  it("パスワードと、打ったときの行き先を送る。変種の無い接続では variant を付けない", () => {
    assert.deepEqual(rememberParams({ owner: owner(), password: "pw" }), {
      connection: "shop",
      kind: "postgres",
      host: "db.example.com",
      port: 5432,
      user: "app",
      password: "pw",
    });
    assert.equal(
      rememberParams({
        owner: owner("@local", { variant: "prod" }),
        password: "pw",
      }).variant,
      "prod",
    );
  });

  it("kisui serve が覚えなかったら（行き先が変わった）、Window も捨てる", async () => {
    const m = new PasswordMemory();
    m.remember(owner(), "pw");
    const e = m.find({ target: "@local", connection: "shop" })!;
    assert.equal(
      await handBack(m, e, async () => ({ remembered: false })),
      false,
    );
    assert.equal(m.find({ target: "@local", connection: "shop" }), undefined);
  });

  it("送れなかったら（切れた）、捨てずに残す", async () => {
    const m = new PasswordMemory();
    m.remember(owner(), "pw");
    const e = m.find({ target: "@local", connection: "shop" })!;
    const failed = await handBack(m, e, async () => {
      throw new Error("not connected");
    });
    assert.equal(failed, false);
    assert.equal(m.find({ target: "@local", connection: "shop" }), e);
  });

  it("handBackAll は、そのマシンに覚えているものだけを全部送る", async () => {
    const m = new PasswordMemory();
    m.remember(owner(), "one");
    m.remember(owner("@local", { variant: "prod" }), "two");
    m.remember(owner("ssh-host"), "three");
    const sent: string[] = [];
    await handBackAll(m, "@local", async (p) => {
      sent.push(p.password);
      return { remembered: true };
    });
    assert.deepEqual(sent.sort(), ["one", "two"]);
  });
});

describe("newlyConnected（session.hello が通ったマシンを見つける）", () => {
  const hello = (...capabilities: string[]) =>
    ({ capabilities }) as HelloResult;

  it("つながったとき・つなぎ直したときに 1 度ずつ。印 db-remember の無い kisui serve は入れない", () => {
    const seen = new Map<string, HelloResult>();
    const first = hello("db", "db-remember");
    const old = hello("db");
    let states: Record<string, { kind: string; hello?: HelloResult }> = {
      a: { kind: "connecting" },
      b: { kind: "connected", hello: old },
    };
    assert.deepEqual(newlyConnected(seen, states), []);
    states = { ...states, a: { kind: "connected", hello: first } };
    assert.deepEqual(newlyConnected(seen, states), ["a"]);
    // 同じ接続のまま、ほかのマシンの様子だけが変わった
    assert.deepEqual(newlyConnected(seen, { ...states }), []);
    // 切れて、つなぎ直した（hello の返事は別のもの）
    states = { ...states, a: { kind: "reconnecting" } };
    assert.deepEqual(newlyConnected(seen, states), []);
    states = {
      ...states,
      a: { kind: "connected", hello: hello("db", "db-remember") },
    };
    assert.deepEqual(newlyConnected(seen, states), ["a"]);
  });
});

describe("Window が覚えたパスワードで、聞かずに続ける", () => {
  it("打って通ったパスワードを覚える。通らなかったものは覚えない", async () => {
    const serve = fakeServe();
    const w = fakeWindow(serve, ["wrong", "right"]);
    assert.equal(await w.request(), "rows");
    assert.deepEqual(w.asked, ["missing", "rejected"]);
    const e = w.memory.find(w.place);
    assert.equal(e?.password, "right");
    assert.deepEqual(e?.owner, owner());
  });

  it("つなぎ直したあとに、覚えているパスワードを渡し直す（kisui serve は、聞かれずにまた使える）", async () => {
    const serve = fakeServe();
    const w = fakeWindow(serve, ["right"]);
    await w.request();
    serve.forgetAll(); // Window の接続が切れた
    assert.equal(serve.kept, undefined);
    await w.reconnect();
    assert.equal(serve.kept, "right");
    assert.deepEqual(serve.remembers, [
      {
        connection: "shop",
        kind: "postgres",
        host: "db.example.com",
        port: 5432,
        user: "app",
        password: "right",
      },
    ]);
    assert.equal(await w.request(), "rows");
    assert.deepEqual(w.asked, ["missing"]); // 聞いたのは、最初の 1 回だけ
  });

  it("missing で断られたら、聞かずに 1 度だけ、渡し直して送り直す", async () => {
    const serve = fakeServe();
    const w = fakeWindow(serve, ["right"]);
    await w.request();
    serve.forgetAll();
    serve.queries.length = 0;
    assert.equal(await w.request(), "rows");
    assert.deepEqual(w.asked, ["missing"]); // 最初の 1 回だけ
    assert.equal(serve.remembers.length, 1);
    // 送り直しは、パスワードを付けない要求（パスワードは db.remember で渡した）
    assert.deepEqual(serve.queries, [undefined, undefined]);
  });

  it("キーチェーンかファイルのパスワードが断られたときも、覚えていれば渡し直して送り直す", async () => {
    const m = new PasswordMemory();
    m.remember(owner(), "typed");
    let handedBack = 0;
    const sent: (string | undefined)[] = [];
    const r = await withPassword(
      async (p) => {
        sent.push(p);
        if (handedBack === 0) throw need("rejected", "keychain");
        return "rows";
      },
      async () => assert.fail("聞かない"),
      passwordKeeper(
        m,
        { target: "@local", connection: "shop" },
        {
          owner: async () => owner(),
          send: async () => {
            handedBack++;
            return { remembered: true };
          },
        },
      ),
    );
    assert.equal(r, "rows");
    assert.equal(handedBack, 1);
    assert.deepEqual(sent, [undefined, undefined]);
  });

  it("渡し直しても missing のままなら、2 度目は渡し直さずに聞く", async () => {
    const m = new PasswordMemory();
    m.remember(owner(), "typed");
    let handedBack = 0;
    const asked: string[] = [];
    const sent: (string | undefined)[] = [];
    await withPassword(
      async (p) => {
        sent.push(p);
        if (p === undefined) throw need("missing");
        return "rows";
      },
      async (reason) => {
        asked.push(reason);
        return "again";
      },
      passwordKeeper(
        m,
        { target: "@local", connection: "shop" },
        {
          owner: async () => owner(),
          send: async () => {
            handedBack++;
            return { remembered: true };
          },
        },
      ),
    );
    assert.equal(handedBack, 1);
    assert.deepEqual(sent, [undefined, undefined, "again"]);
    assert.deepEqual(asked, ["missing"]);
  });

  it("渡し直したパスワードを DB が断ったら、覚えたものを捨てて聞く", async () => {
    const serve = fakeServe("changed");
    const w = fakeWindow(serve, ["changed"]);
    w.memory.remember(owner(), "old");
    assert.equal(await w.request(), "rows");
    assert.deepEqual(w.asked, ["rejected"]);
    assert.deepEqual(serve.queries, [undefined, undefined, "changed"]);
    assert.equal(w.memory.find(w.place)?.password, "changed");
  });

  it("渡し直したものが断られ、聞く Dialog もやめたら、覚えたものは残らない", async () => {
    const serve = fakeServe("changed");
    const w = fakeWindow(serve, [null]);
    w.memory.remember(owner(), "old");
    await assert.rejects(w.request());
    assert.equal(w.memory.find(w.place), undefined);
  });

  it("kisui serve が覚えていたものを DB が断ったら、Window も捨てる", async () => {
    const serve = fakeServe("changed");
    const w = fakeWindow(serve, ["changed"]);
    w.memory.remember(owner(), "old");
    serve.kept = "old"; // つなぎ直したときに渡してある
    assert.equal(await w.request(), "rows");
    assert.equal(serve.remembers.length, 0); // 渡し直さない（kisui serve は持っていた）
    assert.deepEqual(w.asked, ["rejected"]);
    assert.equal(w.memory.find(w.place)?.password, "changed");
  });

  for (const [what, change] of [
    ["ホスト", { host: "other.example.com" }],
    ["ポート", { port: 6543 }],
    ["ユーザー", { user: "admin" }],
    ["種類", { kind: "mysql" }],
  ] as const) {
    it(`設定の${what}が変わったら、覚えたものを使わずに聞き、捨てる`, async () => {
      const serve = fakeServe();
      const w = fakeWindow(serve, ["right"]);
      await w.request();
      serve.forgetAll();
      serve.config = conn(change); // 同じ名前の接続が、別の行き先を指すようになった
      serve.queries.length = 0;
      w.asked.length = 0;
      await w.reconnect();
      assert.equal(serve.kept, undefined); // 渡し直しても、kisui serve は覚えない
      assert.equal(w.memory.find(w.place), undefined); // Window も捨てた

      w.memory.remember(owner(), "right"); // つなぎ直しより先に要求が出たとき
      await assert.rejects(w.request());
      assert.deepEqual(w.asked, ["missing"]); // 聞く（答えなかった）
      assert.deepEqual(serve.queries, [undefined]); // 前の行き先のパスワードでは、ログインを試していない
      assert.equal(w.memory.find(w.place), undefined);
    });
  }

  it("別のマシン・別の変種に覚えたものは、使わない", async () => {
    const serve = fakeServe();
    const w = fakeWindow(serve, []);
    w.memory.remember(owner("ssh-host"), "right");
    w.memory.remember(owner("@local", { variant: "prod" }), "right");
    await assert.rejects(w.request());
    assert.equal(serve.remembers.length, 0);
    assert.deepEqual(w.asked, ["missing"]);
  });

  it("行き先を聞けないまま通ったパスワードは覚えず、前に覚えたものも捨てる", async () => {
    const m = new PasswordMemory();
    const place = { target: "@local", connection: "shop" };
    m.remember(owner(), "old");
    const keeper = passwordKeeper(m, place, {
      owner: async () => {
        throw new Error("not connected");
      },
      send: async () => ({ remembered: false }),
    });
    (await keeper.typed("new"))();
    assert.equal(m.find(place), undefined);
  });

  it("打ったパスワードでログインが通り、DB が文を断ったときも覚える。つながらなかったときは覚えない", async () => {
    for (const [kind, kept] of [
      ["query", "typed"],
      ["connect", undefined],
      ["cancelled", undefined],
    ] as const) {
      const m = new PasswordMemory();
      const place = { target: "@local", connection: "shop" };
      const failure = new RpcError({
        code: ErrorCode.DbError,
        message: "refused",
        data: { kind },
      });
      await assert.rejects(
        withPassword(
          async (p) => {
            if (p === undefined) throw need("missing");
            throw failure;
          },
          async () => "typed",
          passwordKeeper(m, place, {
            owner: async () => owner(),
            send: async () => ({ remembered: false }),
          }),
        ),
        (e) => e === failure,
      );
      assert.equal(m.find(place)?.password, kept, kind);
    }
  });

  it("keeper を渡さなければ（古い kisui serve）、覚えも渡し直しもしない", async () => {
    const sent: (string | undefined)[] = [];
    const asked: string[] = [];
    await withPassword(
      async (p) => {
        sent.push(p);
        if (p === undefined) throw need("missing");
        return "rows";
      },
      async (reason) => {
        asked.push(reason);
        return "typed";
      },
    );
    assert.deepEqual(sent, [undefined, "typed"]);
    assert.deepEqual(asked, ["missing"]);
  });
});
