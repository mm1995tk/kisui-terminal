import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Workspace } from "../rpc/protocol.ts";
import type { KeyValueStore } from "../ssh/machines.ts";
import {
  loadOrder,
  moveInOrder,
  ORDER_KEY,
  pruneOrder,
  saveOrder,
  sortByOrder,
} from "./order.ts";

const r = (target: string, id: string) => ({ target, id });
const mem = (init?: string): KeyValueStore & { v: string | null } => ({
  v: init ?? null,
  getItem() {
    return this.v;
  },
  setItem(_k, value) {
    this.v = value;
  },
});

describe("loadOrder / saveOrder", () => {
  it("書いたものを読める。無い・壊れている・形が違うときは空（重なりと形の違う行は捨てる）", () => {
    const s = mem();
    assert.deepEqual(loadOrder(s), []);
    saveOrder(s, [r("a", "1"), r("b", "2")]);
    assert.deepEqual(loadOrder(s), [r("a", "1"), r("b", "2")]);
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

  it("保存できなくても例外にしない", () => {
    const bad: KeyValueStore = {
      getItem() {
        throw new Error("x");
      },
      setItem() {
        throw new Error("x");
      },
    };
    saveOrder(bad, [r("a", "1")]);
    assert.deepEqual(loadOrder(bad), []);
    assert.equal(typeof ORDER_KEY, "string");
  });
});

describe("sortByOrder", () => {
  it("記録にあるものはその順、無いものは元の順で後ろ", () => {
    const items = [r("a", "1"), r("a", "2"), r("b", "3"), r("b", "4")];
    assert.deepEqual(
      sortByOrder(items, (x) => x, [r("b", "4"), r("a", "1")]),
      [r("b", "4"), r("a", "1"), r("a", "2"), r("b", "3")],
    );
    assert.deepEqual(
      sortByOrder(items, (x) => x, []),
      items,
    );
  });
});

describe("moveInOrder", () => {
  const shown = [r("a", "1"), r("b", "2"), r("a", "3")];

  it("1 つ下・上へ動かす（記録に無かったものも、並びが記録になる）", () => {
    assert.deepEqual(moveInOrder([], shown, r("a", "1"), "down"), [
      r("b", "2"),
      r("a", "1"),
      r("a", "3"),
    ]);
    assert.deepEqual(moveInOrder([], shown, r("a", "3"), "up"), [
      r("a", "1"),
      r("a", "3"),
      r("b", "2"),
    ]);
  });

  it("端では動かさない（null）。並びに無いものも null", () => {
    assert.equal(moveInOrder([], shown, r("a", "1"), "up"), null);
    assert.equal(moveInOrder([], shown, r("a", "3"), "down"), null);
    assert.equal(moveInOrder([], shown, r("z", "9"), "down"), null);
  });

  it("今は出ていないもの（切れているマシン）の記録の場所は変えない", () => {
    const order = [r("a", "1"), r("gone", "x"), r("b", "2")];
    assert.deepEqual(
      moveInOrder(order, [r("a", "1"), r("b", "2")], r("a", "1"), "down"),
      [r("b", "2"), r("gone", "x"), r("a", "1")],
    );
  });
});

describe("pruneOrder", () => {
  const w = (id: string) => ({ id }) as Workspace;
  it("一覧が分かっているマシンの、もう無い id を外す。一覧が分からないマシンのものは残す", () => {
    assert.deepEqual(
      pruneOrder([r("a", "1"), r("a", "2"), r("off", "9")], { a: [w("1")] }),
      [r("a", "1"), r("off", "9")],
    );
  });
});
