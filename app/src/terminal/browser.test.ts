import assert from "node:assert/strict";
import { test } from "node:test";

import { boundsOf, normalizeUrl, sameBounds } from "./browser.ts";

test("normalizeUrl: keeps http and https", () => {
  assert.equal(normalizeUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(normalizeUrl("  HTTP://x.example "), "HTTP://x.example");
});

test("normalizeUrl: adds a scheme", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(
    normalizeUrl("example.com:8443/x?y=1"),
    "https://example.com:8443/x?y=1",
  );
  assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeUrl("localhost:3000/a#b"), "http://localhost:3000/a#b");
  assert.equal(normalizeUrl("127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(normalizeUrl("app.localhost"), "http://app.localhost");
  assert.equal(normalizeUrl("[::1]:3000"), "http://[::1]:3000");
});

test("normalizeUrl: refuses other schemes and junk", () => {
  for (const bad of [
    "",
    "   ",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hi",
    "tauri://localhost/",
    "ftp://x.example/",
    "//evil.example",
    "/etc/passwd",
    "a b",
    "http://a\nb",
  ]) {
    assert.equal(normalizeUrl(bad), null, JSON.stringify(bad));
  }
});

test("boundsOf rounds and never returns an empty size", () => {
  assert.deepEqual(
    boundsOf({ left: 10.4, top: 20.6, width: 300.2, height: 0 }),
    {
      x: 10,
      y: 21,
      w: 300,
      h: 1,
    },
  );
  const b = boundsOf({ left: 1, top: 2, width: 3, height: 4 });
  assert.ok(sameBounds(b, { x: 1, y: 2, w: 3, h: 4 }));
  assert.ok(!sameBounds(undefined, b));
  assert.ok(!sameBounds(b, { x: 1, y: 2, w: 3, h: 5 }));
});
