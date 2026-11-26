import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";

import type { Problem } from "../problem.ts";

// node では solid-js がサーバー用（onMount が動かない作り）に解決されるので、ブラウザー用に向け直す（compose.test.ts と同じ）
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    nextResolve(
      specifier === "solid-js" ? "solid-js/dist/solid.js" : specifier,
      context,
    ),
});
const { createRoot } = await import("solid-js");
const { watchCookieMismatch } = await import("./cookieMismatch.ts");

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("watchCookieMismatch", () => {
  it("殻の知らせが届いたら、食い違いを 1 行ずつ並べて知らせ、片付けたら聞くのをやめる", async () => {
    let handler: ((p: string[]) => void) | undefined;
    let off = false;
    const reported: (Problem | null)[] = [];
    const dispose = createRoot((dispose) => {
      watchCookieMismatch({
        os: {
          onCookieMismatch: async (h) => {
            handler = h;
            return () => void (off = true);
          },
        },
        browser: true,
        setFocusError: (p) => reported.push(p),
      });
      return dispose;
    });
    await settle();
    assert.ok(handler);
    handler([
      "a (domain .x.com, path /): HttpOnly: want false, got true",
      "b (domain x.com, path /): not stored",
    ]);
    assert.equal(reported.length, 1);
    assert.equal(
      reported[0]?.error,
      "a (domain .x.com, path /): HttpOnly: want false, got true\nb (domain x.com, path /): not stored",
    );
    assert.notEqual(reported[0]?.title, "");
    dispose();
    assert.equal(off, true);
  });

  it("内蔵ブラウザを使わないときは聞かない", async () => {
    let listened = false;
    createRoot((dispose) => {
      watchCookieMismatch({
        os: {
          onCookieMismatch: async () => {
            listened = true;
            return () => {};
          },
        },
        browser: false,
        setFocusError: () => {},
      });
      return dispose;
    });
    await settle();
    assert.equal(listened, false);
  });
});
