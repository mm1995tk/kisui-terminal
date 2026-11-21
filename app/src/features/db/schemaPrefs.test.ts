import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DbCatalog } from "../../infrastructure/rpc/protocol.ts";
import type { KeyValueStore } from "../keyValueStore.ts";
import {
  canNarrow,
  chosenFor,
  connectionKey,
  DB_SCHEMA_PREFS_KEY,
  loadSchemaPrefs,
  onlySchema,
  parseSchemaPrefs,
  saveSchemaPrefs,
  schemaChoices,
  withSchemaPref,
} from "./schemaPrefs.ts";

function memStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

/** スキーマ names（テーブルは無い）の一覧。defaultSchema を渡さなければ、フィールドが無い（古い kisui serve）。 */
function catalogOf(
  names: readonly string[],
  extra: Partial<DbCatalog> = {},
): DbCatalog {
  return {
    truncated: false,
    schemas: names.map((name) => ({ name, tables: [] })),
    ...extra,
  };
}

describe("connectionKey（接続を見分ける名前）", () => {
  it("マシン・接続の名前・変種のどれかが違えば、別の接続", () => {
    const base = { target: "@local", connection: "shop" };
    const keys = [
      connectionKey(base),
      connectionKey({ ...base, target: "dev" }),
      connectionKey({ ...base, connection: "blog" }),
      connectionKey({ ...base, variant: "prod" }),
    ];
    assert.equal(new Set(keys).size, keys.length);
  });

  it("タブが違っても、同じ接続なら同じ。変種が無いのと空は同じ", () => {
    assert.equal(
      connectionKey({ target: "@local", connection: "shop" }),
      connectionKey({ target: "@local", connection: "shop", variant: "" }),
    );
  });

  it("名前の中の区切りの字で、別の接続と重ならない", () => {
    assert.notEqual(
      connectionKey({ target: 'a","b', connection: "c" }),
      connectionKey({ target: "a", connection: 'b","c' }),
    );
  });
});

describe("withSchemaPref（接続 1 つの分を変える）", () => {
  it("渡したものだけを変え、ほかの接続の分は残す", () => {
    const all = { a: { schema: "app" }, b: { all: true } };
    assert.deepEqual(withSchemaPref(all, "a", { all: true }), {
      a: { schema: "app", all: true },
      b: { all: true },
    });
    assert.deepEqual(withSchemaPref(all, "b", { schema: "audit" }), {
      a: { schema: "app" },
      b: { schema: "audit", all: true },
    });
    assert.deepEqual(all, { a: { schema: "app" }, b: { all: true } });
  });

  it("schema の null と all の false は、その分を除く。何も残らない接続は除く", () => {
    const all = { a: { schema: "app", all: true } };
    assert.deepEqual(withSchemaPref(all, "a", { schema: null }), {
      a: { all: true },
    });
    assert.deepEqual(withSchemaPref(all, "a", { all: false }), {
      a: { schema: "app" },
    });
    assert.deepEqual(
      withSchemaPref({ a: { schema: "app" } }, "a", { schema: null }),
      {},
    );
    assert.deepEqual(withSchemaPref({}, "a", { all: false }), {});
  });
});

describe("loadSchemaPrefs・saveSchemaPrefs（接続ごとの記録）", () => {
  it("書いたものを読める（アプリを開き直しても残る）", () => {
    const store = memStore();
    const key = connectionKey({ target: "@local", connection: "shop" });
    const prefs = withSchemaPref({}, key, { schema: "audit", all: true });
    saveSchemaPrefs(store, prefs);
    assert.deepEqual(loadSchemaPrefs(store), {
      [key]: { schema: "audit", all: true },
    });
    assert.deepEqual(JSON.parse(store.data.get(DB_SCHEMA_PREFS_KEY)!), {
      version: 1,
      connections: { [key]: { schema: "audit", all: true } },
    });
  });

  it("無い・壊れている・版が違う・形が違うときは空", () => {
    const store = memStore();
    assert.deepEqual(loadSchemaPrefs(store), {});
    assert.deepEqual(loadSchemaPrefs(undefined), {});
    store.setItem(DB_SCHEMA_PREFS_KEY, "{");
    assert.deepEqual(loadSchemaPrefs(store), {});
    assert.deepEqual(
      parseSchemaPrefs({ version: 2, connections: { a: { schema: "x" } } }),
      {},
    );
    assert.deepEqual(parseSchemaPrefs({ version: 1, connections: null }), {});
    assert.deepEqual(parseSchemaPrefs(null), {});
  });

  it("形の違う分だけを捨てる", () => {
    assert.deepEqual(
      parseSchemaPrefs({
        version: 1,
        connections: {
          a: { schema: 1, all: "yes" },
          b: { schema: "x", all: false },
          c: "x",
          d: { schema: "", all: true },
        },
      }),
      { b: { schema: "x" }, d: { all: true } },
    );
  });

  it("書けなくても投げない", () => {
    const store: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("full");
      },
    };
    saveSchemaPrefs(store, { a: { all: true } });
    saveSchemaPrefs(undefined, { a: { all: true } });
  });
});

describe("schemaChoices（ドロップダウンの中身）", () => {
  it("選んでいなければ、DB の既定のスキーマを示す", () => {
    const c = catalogOf(["audit", "public"], { defaultSchema: "public" });
    assert.deepEqual(schemaChoices(c, undefined), {
      options: ["audit", "public"],
      selected: "public",
    });
  });

  it("選んでいれば、それを示す", () => {
    const c = catalogOf(["audit", "public"], { defaultSchema: "public" });
    assert.deepEqual(schemaChoices(c, "audit"), {
      options: ["audit", "public"],
      selected: "audit",
    });
  });

  it("DB の既定のスキーマが一覧に無い（null・一覧の外・返さない古い kisui serve）ときは、先頭に「DB の既定」を置く", () => {
    for (const extra of [
      { defaultSchema: null },
      { defaultSchema: "gone" },
      {},
    ] as const) {
      const c = catalogOf(["audit", "public"], extra);
      assert.deepEqual(schemaChoices(c, undefined), {
        options: [null, "audit", "public"],
        selected: null,
      });
      assert.deepEqual(schemaChoices(c, "audit"), {
        options: [null, "audit", "public"],
        selected: "audit",
      });
    }
  });

  it("選んだスキーマが一覧に無ければ（一覧が途中で切れている）、後ろに足して示す", () => {
    const c = catalogOf(["audit", "public"], {
      defaultSchema: "public",
      truncated: true,
    });
    assert.deepEqual(schemaChoices(c, "zzz"), {
      options: ["audit", "public", "zzz"],
      selected: "zzz",
    });
  });
});

describe("chosenFor（ドロップダウンで選んだときに覚えるスキーマ）", () => {
  it("DB の既定のスキーマと「DB の既定」は覚えない。ほかは覚える", () => {
    const c = catalogOf(["audit", "public"], { defaultSchema: "public" });
    assert.equal(chosenFor(c, "public"), null);
    assert.equal(chosenFor(c, "audit"), "audit");
    const old = catalogOf(["audit", "public"]);
    assert.equal(chosenFor(old, null), null);
    assert.equal(chosenFor(old, "public"), "public");
  });
});

describe("onlySchema（木に出すスキーマ）", () => {
  const c = catalogOf(["audit", "public"], { defaultSchema: "public" });

  it("印が無ければ、ドロップダウンが示すスキーマだけ（選んでいなければ DB の既定）", () => {
    assert.equal(onlySchema(c, undefined, false), "public");
    assert.equal(onlySchema(c, "audit", false), "audit");
  });

  it("印があれば、すべてのスキーマ", () => {
    assert.equal(onlySchema(c, undefined, true), undefined);
    assert.equal(onlySchema(c, "audit", true), undefined);
  });

  it("示すスキーマが無い・一覧に無いときは、印が無くてもすべてのスキーマ（木を空にしない）", () => {
    // DB の既定のスキーマを返さない古い kisui serve
    assert.equal(
      onlySchema(catalogOf(["a", "b"]), undefined, false),
      undefined,
    );
    // MySQL で DB を指定せずに接続した
    assert.equal(
      onlySchema(catalogOf(["a"], { defaultSchema: null }), undefined, false),
      undefined,
    );
    // 選んだスキーマが、途中で切れた一覧に無い
    assert.equal(
      onlySchema({ ...c, truncated: true }, "zzz", false),
      undefined,
    );
    // 古い kisui serve でも、選んだスキーマが一覧にあれば絞る
    assert.equal(onlySchema(catalogOf(["a", "b"]), "b", false), "b");
  });

  it("canNarrow：絞る先のスキーマがあるときだけ、印を切り替えられる", () => {
    assert.equal(canNarrow(c, undefined), true);
    assert.equal(canNarrow(catalogOf(["a", "b"]), undefined), false);
    assert.equal(canNarrow(catalogOf(["a", "b"]), "b"), true);
  });
});
