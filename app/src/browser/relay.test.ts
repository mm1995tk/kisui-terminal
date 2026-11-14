import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { relayedOf, unrelay } from "./relay.ts";

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
  const r = {
    local: "http://127.0.0.1:23456",
    original: "http://localhost:3000",
  };
  it("中継の origin の URL を、元の origin に戻す（パス・クエリ・# は残す）", () => {
    assert.equal(
      unrelay("http://127.0.0.1:23456/x/y?q=1#f", r),
      "http://localhost:3000/x/y?q=1#f",
    );
  });
  it("元の URL が既定のポートなら、ポートを付けない", () => {
    const d = {
      local: "http://127.0.0.1:23456",
      original: "http://app.localhost",
    };
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
});
