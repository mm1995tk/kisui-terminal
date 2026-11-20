import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ago,
  emptyMessage,
  filterEntries,
  historyKey,
  moveSelection,
  preview,
} from "./history.ts";
import { setLang } from "../../i18n/index.ts";

// 日本語の文で確かめる（画面の言葉の既定は英語）
setLang("ja");

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

test("emptyMessage は空の理由ごとに文を変える", () => {
  const e = [{ text: "a", copiedAt: 1 }];
  assert.equal(emptyMessage(true, undefined), "履歴を読めませんでした");
  assert.equal(emptyMessage(false, undefined), "読み込んでいます");
  assert.equal(emptyMessage(false, []), "履歴はまだありません");
  assert.equal(emptyMessage(false, e), "当てはまるものがありません");
});

const ev = (key: string, mods: object = {}) => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

test("historyKey は、↓ ↑ と Ctrl+J / Ctrl+K で選ぶ行を動かす", () => {
  assert.deepEqual(historyKey(ev("ArrowDown"), true), {
    kind: "step",
    step: 1,
  });
  assert.deepEqual(historyKey(ev("ArrowUp"), true), { kind: "step", step: -1 });
  assert.deepEqual(historyKey(ev("j", { ctrlKey: true }), false), {
    kind: "step",
    step: 1,
  });
  assert.deepEqual(historyKey(ev("k", { ctrlKey: true }), false), {
    kind: "step",
    step: -1,
  });
});

test("historyKey は、Enter で貼り、Shift+Enter でクリップボードに戻す", () => {
  assert.deepEqual(historyKey(ev("Enter"), false), { kind: "choose" });
  assert.deepEqual(historyKey(ev("Enter", { shiftKey: true }), false), {
    kind: "putBack",
  });
});

test("historyKey の ? は、絞り込みが空のときだけキーの一覧。打っている途中の ? は入力欄の字", () => {
  assert.deepEqual(historyKey(ev("?", { shiftKey: true }), true), {
    kind: "help",
  });
  assert.equal(historyKey(ev("?", { shiftKey: true }), false), null);
  assert.equal(historyKey(ev("?", { ctrlKey: true }), true), null);
});

test("historyKey は、字と変換中のキーを入力欄に渡す", () => {
  assert.equal(historyKey(ev("j"), true), null);
  assert.equal(historyKey(ev("a"), true), null);
  assert.equal(historyKey(ev("Enter", { isComposing: true }), true), null);
  assert.equal(historyKey(ev("Enter", { keyCode: 229 }), true), null);
  assert.equal(historyKey(ev("?", { isComposing: true }), true), null);
});
