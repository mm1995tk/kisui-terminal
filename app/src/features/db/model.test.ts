import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setLang } from "../../i18n/index.ts";
import { ErrorCode, RpcError } from "../../infrastructure/rpc/message.ts";
import type {
  DbConnection,
  DbQueryResult,
} from "../../infrastructure/rpc/protocol.ts";
import type { KeyValueStore } from "../keyValueStore.ts";
import {
  catalogError,
  cellText,
  collectConnections,
  connectionDetail,
  connectionOf,
  DB_TABS_KEY,
  elapsedText,
  loadDrafts,
  parseDrafts,
  PasswordCancelled,
  queryFailure,
  resultSummary,
  saveDrafts,
  withPassword,
} from "./model.ts";

setLang("en");

function memStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

const conn = (
  name: string,
  extra: Partial<DbConnection> = {},
): DbConnection => ({
  name,
  kind: "postgres",
  host: "db.example",
  port: 5432,
  user: "app",
  database: "shop",
  readOnly: false,
  ...extra,
});

describe("書きかけの SQL の記録", () => {
  it("書いて読むと戻る。開いているタブ（ids）の分だけ書き、空の SQL は書かない", () => {
    const store = memStore();
    saveDrafts(
      store,
      { db1: "select 1", db2: "", gone: "select 2" },
      new Set(["db1", "db2"]),
    );
    assert.deepEqual(loadDrafts(store), { db1: "select 1" });
    assert.deepEqual(JSON.parse(store.data.get(DB_TABS_KEY)!), {
      version: 1,
      sql: { db1: "select 1" },
    });
  });

  it("無い・壊れている・版が違う・形が違うときは空", () => {
    const store = memStore();
    assert.deepEqual(loadDrafts(store), {});
    assert.deepEqual(loadDrafts(undefined), {});
    store.setItem(DB_TABS_KEY, "{");
    assert.deepEqual(loadDrafts(store), {});
    assert.deepEqual(parseDrafts({ version: 2, sql: { a: "x" } }), {});
    assert.deepEqual(parseDrafts({ version: 1, sql: { a: 1, b: "y" } }), {
      b: "y",
    });
  });

  it("書けなくても投げない", () => {
    const store: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("full");
      },
    };
    saveDrafts(store, { a: "x" }, new Set(["a"]));
  });
});

describe("接続の一覧をまとめる", () => {
  it("マシンの順、その中は設定の順。どのマシンのものかを付ける。設定の間違いと聞けなかったマシンは知らせにする", () => {
    const r = collectConnections([
      {
        target: "@local",
        machine: "Local",
        color: "#1",
        connections: [conn("dev"), conn("test")],
        problems: ["db.connections[2]: unknown key password"],
      },
      { target: "host-b", machine: "B", color: "#2", error: "closed" },
      {
        target: "host-c",
        machine: "C",
        color: "#3",
        connections: [conn("prod", { readOnly: true })],
      },
    ]);
    assert.deepEqual(
      r.choices.map((c) => [c.target, c.connection.name]),
      [
        ["@local", "dev"],
        ["@local", "test"],
        ["host-c", "prod"],
      ],
    );
    assert.equal(r.choices[2].machine, "C");
    assert.deepEqual(r.notes, [
      "Local: db.connections[2]: unknown key password",
      "B: could not get the connections (closed)",
    ]);
  });

  it("接続が 1 つも無ければ空", () => {
    assert.deepEqual(collectConnections([]), { choices: [], notes: [] });
  });

  it("接続の行き先の説明（Unix ソケットはパス、DB 名・ユーザーが無ければ省く）", () => {
    assert.equal(
      connectionDetail(conn("x")),
      "postgres · app@db.example:5432/shop",
    );
    assert.equal(
      connectionDetail(
        conn("x", {
          kind: "mysql",
          host: "/run/mysqld",
          user: "",
          database: "",
        }),
      ),
      "mysql · /run/mysqld",
    );
  });
});

describe("kisui serve の断り", () => {
  const rpc = (code: number, message: string, data?: unknown) =>
    new RpcError({ code, message, data });

  it("password_required は、パスワードを聞く（missing・rejected）", () => {
    assert.deepEqual(
      queryFailure(rpc(ErrorCode.PasswordRequired, "x", { reason: "missing" })),
      { kind: "password", reason: "missing" },
    );
    assert.deepEqual(
      queryFailure(
        rpc(ErrorCode.PasswordRequired, "x", { reason: "rejected" }),
      ),
      { kind: "password", reason: "rejected" },
    );
    // キーチェーンかファイルで見つけたものが断られたら、その場所も（#356）。知らない値は捨てる。
    assert.deepEqual(
      queryFailure(
        rpc(ErrorCode.PasswordRequired, "x", {
          reason: "rejected",
          passwordSource: "file",
        }),
      ),
      { kind: "password", reason: "rejected", passwordSource: "file" },
    );
    assert.deepEqual(
      queryFailure(
        rpc(ErrorCode.PasswordRequired, "x", {
          reason: "rejected",
          passwordSource: "nope",
        }),
      ),
      { kind: "password", reason: "rejected" },
    );
  });

  it("db_error は DB の言葉そのまま（コードを前に付けない）と SQLSTATE。取り消しは cancelled", () => {
    assert.deepEqual(
      queryFailure(
        rpc(ErrorCode.DbError, 'relation "nope" does not exist', {
          kind: "query",
          sqlState: "42P01",
        }),
      ),
      {
        kind: "error",
        message: 'relation "nope" does not exist',
        sqlState: "42P01",
      },
    );
    assert.deepEqual(
      queryFailure(rpc(ErrorCode.DbError, "canceled", { kind: "cancelled" })),
      { kind: "cancelled" },
    );
  });

  it("not_found・busy・denied は画面の文。ほかの Error はその文", () => {
    assert.deepEqual(queryFailure(rpc(ErrorCode.NotFound, "x")), {
      kind: "error",
      message: "This connection is no longer in the settings of its machine.",
    });
    assert.equal(
      (queryFailure(rpc(ErrorCode.Busy, "x")) as { message: string }).message,
      "Too many statements are running on this machine. Run it again when one ends.",
    );
    assert.equal(
      (queryFailure(rpc(ErrorCode.Denied, "x")) as { message: string }).message,
      "The permission of this connection does not allow running SQL here. It is set in the settings of its machine (human-permission).",
    );
    assert.deepEqual(queryFailure(new Error("closed")), {
      kind: "error",
      message: "closed",
    });
  });
});

describe("結果を画面に出す", () => {
  it("NULL は null、改行・タブは見える字、長い値は切る", () => {
    assert.equal(cellText(null), null);
    assert.equal(cellText(""), "");
    assert.equal(cellText("a\nb\r\nc\td"), "a↵b↵c⇥d");
    assert.equal(cellText("あいうえお", 3), "あいう…");
    assert.equal(cellText("abc", 3), "abc");
  });

  it("かかった時間", () => {
    assert.equal(elapsedText(3.456), "3.5 ms");
    assert.equal(elapsedText(123.4), "123 ms");
    assert.equal(elapsedText(2345), "2.35 s");
  });

  const result = (r: Partial<DbQueryResult>): DbQueryResult => ({
    columns: [],
    rows: [],
    rowCount: 0,
    truncated: false,
    elapsedMs: 1.5,
    ...r,
  });

  it("件数：行を返す文は行数（切ったらそう書く）、返さない文は変えた行数", () => {
    const col = { name: "a", type: "integer", kind: "number" } as const;
    assert.equal(
      resultSummary(result({ columns: [col], rowCount: 2 })),
      "2 rows · 1.5 ms",
    );
    assert.equal(
      resultSummary(
        result({ columns: [col], rowCount: 1000, truncated: true }),
      ),
      "1000 rows · the rows after these were not read · 1.5 ms",
    );
    // ページ送りのある結果（#373）は、何行目から何行目か
    assert.equal(
      resultSummary(
        result({
          columns: [col],
          rowCount: 1000,
          truncated: true,
          wrappable: true,
        }),
      ),
      "rows 1–1000 · more rows on the next page · 1.5 ms",
    );
    assert.equal(
      resultSummary(
        result({ columns: [col], rowCount: 5, wrappable: true, offset: 1000 }),
      ),
      "rows 1001–1005 · 1.5 ms",
    );
    assert.equal(
      resultSummary(result({ rowsAffected: 3 })),
      "3 rows changed · 1.5 ms",
    );
    assert.equal(resultSummary(result({})), "done · 1.5 ms");
  });
});

describe("withPassword（password_required なら聞いて送り直す）", () => {
  const need = (reason: "missing" | "rejected") =>
    new RpcError({
      code: ErrorCode.PasswordRequired,
      message: "password required",
      data: { reason },
    });

  it("要らなければ、パスワードを付けずに 1 回送るだけ", async () => {
    const sent: (string | undefined)[] = [];
    const r = await withPassword(
      async (p) => {
        sent.push(p);
        return "ok";
      },
      async () => assert.fail("聞かない"),
    );
    assert.equal(r, "ok");
    assert.deepEqual(sent, [undefined]);
  });

  it("missing なら聞いて、それを付けて送り直す。rejected ならまた聞く", async () => {
    const sent: (string | undefined)[] = [];
    const asked: string[] = [];
    const answers = ["wrong", "right"];
    const r = await withPassword(
      async (p) => {
        sent.push(p);
        if (p === undefined) throw need("missing");
        if (p === "wrong") throw need("rejected");
        return 42;
      },
      async (reason) => {
        asked.push(reason);
        return answers.shift()!;
      },
    );
    assert.equal(r, 42);
    assert.deepEqual(sent, [undefined, "wrong", "right"]);
    assert.deepEqual(asked, ["missing", "rejected"]);
  });

  it("見つけたパスワードが断られたら、その場所を ask に渡す", async () => {
    const asked: unknown[] = [];
    await withPassword(
      async (p) => {
        if (p === undefined)
          throw new RpcError({
            code: ErrorCode.PasswordRequired,
            message: "refused",
            data: { reason: "rejected", passwordSource: "keychain" },
          });
        return 1;
      },
      async (reason, source) => {
        asked.push([reason, source]);
        return "typed";
      },
    );
    assert.deepEqual(asked, [["rejected", "keychain"]]);
  });

  it("聞く窓をやめたら PasswordCancelled を投げ、送り直さない", async () => {
    let n = 0;
    await assert.rejects(
      withPassword(
        async () => {
          n++;
          throw need("missing");
        },
        async () => null,
      ),
      PasswordCancelled,
    );
    assert.equal(n, 1);
  });

  it("ほかの断りは、聞かずにそのまま投げる", async () => {
    const err = new RpcError({ code: ErrorCode.DbError, message: "syntax" });
    await assert.rejects(
      withPassword(
        async () => {
          throw err;
        },
        async () => assert.fail("聞かない"),
      ),
      (e) => e === err,
    );
  });
});

describe("catalogError（木の一覧を聞けなかった理由の文）", () => {
  const rpc = (code: number, message: string, data?: unknown) =>
    new RpcError({ code, message, data });

  it("パスワードを入れなかった・取り消した・パスワードを断られた・DB の言葉", () => {
    assert.match(
      catalogError(new PasswordCancelled()),
      /password was not given/,
    );
    assert.equal(
      catalogError(rpc(ErrorCode.DbError, "boom", { kind: "cancelled" })),
      "Cancelled.",
    );
    assert.equal(
      catalogError(
        rpc(ErrorCode.PasswordRequired, "x", { reason: "rejected" }),
      ),
      "The password was not accepted.",
    );
    assert.equal(
      catalogError(rpc(ErrorCode.DbError, "no route", { kind: "connect" })),
      "no route",
    );
  });
});

describe("connectionOf", () => {
  const c = (name: string, variant?: string) =>
    ({ name, kind: "mysql", ...(variant ? { variant } : {}) }) as DbConnection;
  const list = [c("shop"), c("shop", "prod"), c("log")];

  it("名前と変種が両方合うものを探す。変種が無ければ変種の無い接続", () => {
    assert.equal(connectionOf(list, { connection: "shop" }), list[0]);
    assert.equal(
      connectionOf(list, { connection: "shop", variant: "prod" }),
      list[1],
    );
    assert.equal(connectionOf(list, { connection: "x" }), undefined);
    assert.equal(
      connectionOf(list, { connection: "log", variant: "dev" }),
      undefined,
    );
  });
});
