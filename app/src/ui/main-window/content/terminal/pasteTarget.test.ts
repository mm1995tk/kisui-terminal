import assert from "node:assert/strict";
import { test } from "node:test";

import { focusedPasteTarget, registerPasteTarget } from "./pasteTarget.ts";

/** contains だけを持つ DOM の代わり。 */
function fakeHost(inside: object[]): HTMLElement {
  return {
    contains: (n: object) => inside.includes(n),
  } as unknown as HTMLElement;
}

test("登録した欄の中の要素なら、その欄の paste を返す", () => {
  const a = {};
  const b = {};
  const pasted: string[] = [];
  const off1 = registerPasteTarget(fakeHost([a]), (t) => pasted.push("1" + t));
  const off2 = registerPasteTarget(fakeHost([b]), (t) => pasted.push("2" + t));
  focusedPasteTarget(b as Element)?.("x");
  focusedPasteTarget(a as Element)?.("y");
  assert.deepEqual(pasted, ["2x", "1y"]);
  off1();
  off2();
});

test("どの欄の中でもなければ undefined", () => {
  const off = registerPasteTarget(fakeHost([]), () => {});
  assert.equal(focusedPasteTarget({} as Element), undefined);
  assert.equal(focusedPasteTarget(null), undefined);
  off();
});

test("登録を外した欄には返さない", () => {
  const a = {};
  const off = registerPasteTarget(fakeHost([a]), () => {});
  off();
  assert.equal(focusedPasteTarget(a as Element), undefined);
});
