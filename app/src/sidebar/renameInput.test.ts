import assert from "node:assert/strict";
import { test } from "node:test";

import { renameKeyAction } from "./renameInput.ts";

test("Enter で決め、Esc でやめる", () => {
  assert.equal(renameKeyAction({ key: "Enter" }), "submit");
  assert.equal(renameKeyAction({ key: "Escape" }), "cancel");
});

test("変換の途中の Enter・Esc は何もしない", () => {
  assert.equal(renameKeyAction({ key: "Enter", isComposing: true }), null);
  assert.equal(renameKeyAction({ key: "Escape", isComposing: true }), null);
});

test("ほかのキーは何もしない", () => {
  assert.equal(renameKeyAction({ key: "a" }), null);
  assert.equal(renameKeyAction({ key: "Tab" }), null);
});

test("変換を確定する Enter が keyCode 229・Process で来ても、決めない", () => {
  assert.equal(renameKeyAction({ key: "Enter", keyCode: 229 }), null);
  assert.equal(renameKeyAction({ key: "Process", keyCode: 13 }), null);
  assert.equal(renameKeyAction({ key: "Enter", keyCode: 13 }), "submit");
});
