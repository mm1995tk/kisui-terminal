import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KeyValueStore } from "../sessions/machines.ts";
import { loadOrder, ORDER_KEY } from "./order.ts";

const r = (target: string, id: string) => ({ target, id });
const mem = (init?: string): KeyValueStore => ({
  getItem: () => init ?? null,
  setItem() {},
});

describe("loadOrder", () => {
  it("前の版が書いたものを読める。無い・壊れている・形が違うときは空（重なりと形の違う行は捨てる）", () => {
    const s = mem(JSON.stringify([r("a", "1"), r("b", "2")]));
    assert.deepEqual(loadOrder(s), [r("a", "1"), r("b", "2")]);
    assert.deepEqual(loadOrder(mem()), []);
    assert.deepEqual(loadOrder(mem("{")), []);
    assert.deepEqual(loadOrder(mem('{"a":1}')), []);
    assert.deepEqual(
      loadOrder(
        mem(
          JSON.stringify([r("a", "1"), r("a", "1"), { target: "a" }, 3, null]),
        ),
      ),
      [r("a", "1")],
    );
    assert.deepEqual(loadOrder(undefined), []);
  });

  it("読めなくても例外にしない", () => {
    const bad: KeyValueStore = {
      getItem() {
        throw new Error("x");
      },
      setItem() {},
    };
    assert.deepEqual(loadOrder(bad), []);
    assert.equal(typeof ORDER_KEY, "string");
  });
});
