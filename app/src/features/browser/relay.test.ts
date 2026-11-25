import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addRelayed, relayedOf, unrelay, type Relayed } from "./relay.ts";

describe("relayedOf", () => {
  it("中継した（origin が変わった）ときだけ対応を作る", () => {
    assert.deepEqual(
      relayedOf("http://localhost:3000/a", "http://127.0.0.1:23456/a"),
      { local: "http://127.0.0.1:23456", original: "http://localhost:3000" },
    );
    assert.equal(
      relayedOf("https://example.com/", "https://example.com/"),
      null,
    );
    assert.equal(relayedOf("not a url", "http://127.0.0.1:1/"), null);
  });
});

describe("unrelay", () => {
  const r = [
    { local: "http://127.0.0.1:23456", original: "http://localhost:3000" },
  ];
  it("中継の origin の URL を、元の origin に戻す（パス・クエリ・# は残す）", () => {
    assert.equal(
      unrelay("http://127.0.0.1:23456/x/y?q=1#f", r),
      "http://localhost:3000/x/y?q=1#f",
    );
  });
  it("元の URL が既定のポートなら、ポートを付けない", () => {
    const d = [
      { local: "http://127.0.0.1:23456", original: "http://app.localhost" },
    ];
    assert.equal(
      unrelay("http://127.0.0.1:23456/", d),
      "http://app.localhost/",
    );
  });
  it("ほかの origin と、対応の無いタブは、そのまま", () => {
    assert.equal(unrelay("https://example.com/", r), "https://example.com/");
    assert.equal(
      unrelay("http://127.0.0.1:23457/", r),
      "http://127.0.0.1:23457/",
    );
    assert.equal(
      unrelay("http://127.0.0.1:23456/", undefined),
      "http://127.0.0.1:23456/",
    );
  });
  it("URL バーでほかの URL に替えたあと戻っても、前の中継の URL を元に戻せる", () => {
    // localhost:3000 を中継で開き、URL バーで localhost:4000（別の中継）に替え、さらに example.com（中継しない）に替える
    let list: readonly Relayed[] = [];
    for (const [orig, opened] of [
      ["http://localhost:3000/", "http://127.0.0.1:23456/"],
      ["http://localhost:4000/", "http://127.0.0.1:23999/"],
      ["https://example.com/", "https://example.com/"],
    ]) {
      const x = relayedOf(orig, opened);
      if (x) list = addRelayed(list, x);
    }
    // 戻ると、ページは前の中継の URL に戻る
    assert.equal(
      unrelay("http://127.0.0.1:23999/b", list),
      "http://localhost:4000/b",
    );
    assert.equal(
      unrelay("http://127.0.0.1:23456/a", list),
      "http://localhost:3000/a",
    );
  });
});

describe("addRelayed", () => {
  it("同じ中継の origin は置き換え、ほかは残す", () => {
    const a = {
      local: "http://127.0.0.1:1",
      original: "http://localhost:3000",
    };
    const b = {
      local: "http://127.0.0.1:2",
      original: "http://localhost:4000",
    };
    const a2 = {
      local: "http://127.0.0.1:1",
      original: "http://127.0.0.1:3000",
    };
    assert.deepEqual(addRelayed(addRelayed([a], b), a2), [b, a2]);
  });
});
