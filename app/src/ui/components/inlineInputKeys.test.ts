import assert from "node:assert/strict";
import { test } from "node:test";

import { inlineKeyAction } from "./inlineInputKeys.ts";

test("Enter で決め、Esc でやめる", () => {
  assert.equal(inlineKeyAction({ key: "Enter" }), "submit");
  assert.equal(inlineKeyAction({ key: "Escape" }), "cancel");
});

test("変換の途中の Enter・Esc は何もしない", () => {
  assert.equal(inlineKeyAction({ key: "Enter", isComposing: true }), null);
  assert.equal(inlineKeyAction({ key: "Escape", isComposing: true }), null);
});

test("ほかのキーは何もしない", () => {
  assert.equal(inlineKeyAction({ key: "a" }), null);
  assert.equal(inlineKeyAction({ key: "Tab" }), null);
});

test("変換を確定する Enter が keyCode 229・Process で来ても、決めない", () => {
  assert.equal(inlineKeyAction({ key: "Enter", keyCode: 229 }), null);
  assert.equal(inlineKeyAction({ key: "Process", keyCode: 13 }), null);
  assert.equal(inlineKeyAction({ key: "Enter", keyCode: 13 }), "submit");
});
