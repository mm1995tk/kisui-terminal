import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { heldCells } from "./hold.ts";

const map = (...xs: string[]) => new Map(xs.map((x) => [x, `at-${x}`]));
const drawnOf =
  (...xs: string[]) =>
  (l: string) =>
    xs.includes(l);

describe("heldCells", () => {
  it("切り替え先のペインがまだ描けていなければ、前のタブのペインを前の位置のまま残す", () => {
    assert.deepEqual(
      heldCells([], map("a1", "a2"), map("b1"), drawnOf("a1", "a2")),
      [
        { link: "a1", view: "at-a1" },
        { link: "a2", view: "at-a2" },
      ],
    );
  });

  it("切り替え先のペインが全部描けたら、残していたペインを外す", () => {
    const held = [{ link: "a1", view: "at-a1" }];
    assert.deepEqual(
      heldCells(held, map("b1"), map("b1"), drawnOf("a1", "b1")),
      [],
    );
  });

  it("描けていなかったペインは残さない。続けて切り替えたら、描けていた最初のペインを残し続ける", () => {
    const held = heldCells([], map("a1"), map("b1"), drawnOf("a1"));
    assert.deepEqual(heldCells(held, map("b1"), map("c1"), drawnOf("a1")), [
      { link: "a1", view: "at-a1" },
    ]);
  });

  it("途中まで描けた分割のタブを挟んで続けて切り替えても、その描けたペイン（まだ見せていない）は足さない", () => {
    // A（a1）→ B（b1・b2。b1 だけ描けた）→ C
    const held = heldCells([], map("a1"), map("b1", "b2"), drawnOf("a1"));
    assert.deepEqual(
      heldCells(held, map("b1", "b2"), map("c1"), drawnOf("a1", "b1")),
      [{ link: "a1", view: "at-a1" }],
    );
  });

  it("残していたペインのタブに戻ったら、そのペインは残すのをやめる（そのまま今のペインになる）", () => {
    const held = [{ link: "a1", view: "at-a1" }];
    assert.deepEqual(heldCells(held, map("b1"), map("a1"), drawnOf("a1")), []);
    assert.deepEqual(
      heldCells(held, map("b1"), map("a1", "c1"), drawnOf("a1")),
      [],
    );
  });

  it("同じタブでペインを足した（外れたペインが無い）ときは、何も残さない", () => {
    assert.deepEqual(
      heldCells([], map("a1"), map("a1", "a2"), drawnOf("a1")),
      [],
    );
  });
});
