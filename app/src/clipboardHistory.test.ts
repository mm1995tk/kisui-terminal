import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ago,
  filterEntries,
  isHistoryKey,
  moveSelection,
  preview,
} from "./clipboardHistory.ts";
import type { KeyLike } from "./guiKeys.ts";

function key(over: Partial<KeyLike>): KeyLike {
  return {
    key: "H",
    code: "KeyH",
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    ...over,
  };
}

test("開くキーは Mac が Cmd+Shift+H、そのほかが Ctrl+Shift+H", () => {
  assert.equal(isHistoryKey(key({ metaKey: true }), true), true);
  assert.equal(isHistoryKey(key({ ctrlKey: true }), true), false);
  assert.equal(isHistoryKey(key({ ctrlKey: true }), false), true);
  assert.equal(isHistoryKey(key({ metaKey: true }), false), false);
});

test("Shift が無い・Alt がある・変換中・別の文字は開かない", () => {
  const c = { ctrlKey: true };
  assert.equal(isHistoryKey(key({ ...c, shiftKey: false }), false), false);
  assert.equal(isHistoryKey(key({ ...c, altKey: true }), false), false);
  assert.equal(isHistoryKey(key({ ...c, isComposing: true }), false), false);
  assert.equal(
    isHistoryKey(key({ ...c, key: "V", code: "KeyV" }), false),
    false,
  );
});

test("preview は改行と空白をたたみ、長ければ切る", () => {
  assert.equal(preview("a\n  b\tc "), "a b c");
  assert.equal(preview("abcdef", 3), "abc…");
  assert.equal(preview("abc", 3), "abc");
  assert.equal(preview("あいうえお", 2), "あい…");
});

test("ago は経った時間を言う", () => {
  const now = 10_000_000;
  assert.equal(ago(now - 5_000, now), "たった今");
  assert.equal(ago(now + 5_000, now), "たった今");
  assert.equal(ago(now - 3 * 60_000, now), "3 分前");
  assert.equal(ago(now - 2 * 3_600_000 - 1000, now), "2 時間前");
});

test("filterEntries は語がすべて含まれるものを順を変えずに残す", () => {
  const es = [
    { text: "Hello World", copiedAt: 3 },
    { text: "hello", copiedAt: 2 },
    { text: "world", copiedAt: 1 },
  ];
  assert.deepEqual(
    filterEntries(es, "WORLD hello").map((e) => e.copiedAt),
    [3],
  );
  assert.deepEqual(
    filterEntries(es, "o").map((e) => e.copiedAt),
    [3, 2, 1],
  );
  assert.equal(filterEntries(es, "  ").length, 3);
  assert.equal(filterEntries(es, "zzz").length, 0);
});

test("moveSelection は端で止まる", () => {
  assert.equal(moveSelection(0, -1, 3), 0);
  assert.equal(moveSelection(2, 1, 3), 2);
  assert.equal(moveSelection(1, 1, 3), 2);
  assert.equal(moveSelection(5, 0, 0), 0);
});
