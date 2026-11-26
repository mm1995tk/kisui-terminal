import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COMMON_KEYS,
  placeKeys,
} from "../../../../features/commands/placeKeys.ts";
import { bookmarkKey } from "../../../../features/browser/bookmarks.ts";
import { bookmarkDialogFooter } from "./bookmarkFooter.ts";

const ev = (key: string, ctrlKey = false) => ({
  key,
  ctrlKey,
  shiftKey: false,
  altKey: false,
  metaKey: false,
});

describe("bookmarkDialogFooter（ブックマークの一覧の下の段の今効く操作。#489）", () => {
  it("選んでいる行がブックマークなら、消す（Ctrl+D）を出す", () => {
    const rows = bookmarkDialogFooter(true);
    assert.deepEqual(
      rows.map((r) => [r.title, r.items.map((i) => i.keys.join(" "))]),
      [["Selected bookmark", ["Ctrl+D"]]],
    );
    assert.deepEqual(bookmarkKey(ev("d", true), false), { kind: "delete" });
  });

  it("フォルダや、行が無いときは、効く操作が無いので見出しだけ", () => {
    assert.deepEqual(
      bookmarkDialogFooter(false).map((r) => [r.title, r.items.length]),
      [["Selected bookmark", 0]],
    );
  });

  it("`?` の一覧の表の操作は、どこでも同じキー（↓ ↑・Enter・Esc・`?`）を除き、下の段に出る。どこでも同じキーは出さない", () => {
    const keys = bookmarkDialogFooter(true).flatMap((r) =>
      r.items.flatMap((i) => i.keys),
    );
    const common = ["↓", "↑", "Enter", "Esc", "?", "Ctrl+J", "Ctrl+K"];
    for (const k of keys) assert.ok(!common.includes(k), k);
    const rest = placeKeys().bookmarks.rows.filter(
      (r) =>
        !r.probes.every((p) => COMMON_KEYS.has(p)) || r.probes.length === 0,
    );
    for (const r of rest)
      if (!/Ctrl\+J|^Esc$/.test(r.keys))
        assert.ok(keys.includes(r.keys), r.keys);
  });
});
