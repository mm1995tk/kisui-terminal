import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import { placeKeys } from "../../../features/commands/placeKeys.ts";
import { dbWindowHints, dbWindowKey } from "./dbWindowKey.ts";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("DB のタブの窓のキー", () => {
  it("j k と矢印で、選ぶ結果のタブを動かす", () => {
    for (const k of ["j", "ArrowDown"])
      assert.deepEqual(dbWindowKey(key(k)), { kind: "select", step: 1 });
    for (const k of ["k", "ArrowUp"])
      assert.deepEqual(dbWindowKey(key(k)), { kind: "select", step: -1 });
    assert.equal(dbWindowKey(key("ArrowDown", { shiftKey: true })), null);
  });

  it("選んだ結果のタブへの操作：Enter 出す・x 閉じる・s 切り替え・f b ページ・e 書き出す", () => {
    assert.deepEqual(dbWindowKey(key("Enter")), { kind: "show" });
    assert.deepEqual(dbWindowKey(key("x")), { kind: "close" });
    assert.deepEqual(dbWindowKey(key("s")), { kind: "view" });
    assert.deepEqual(dbWindowKey(key("f")), { kind: "page", step: "next" });
    assert.deepEqual(dbWindowKey(key("b")), { kind: "page", step: "prev" });
    assert.deepEqual(dbWindowKey(key("e")), { kind: "export" });
  });

  it("タブ全体への操作：c 取り消す・t 木・r 読み直す・h 履歴・p 強める・P 戻す・? 一覧", () => {
    assert.deepEqual(dbWindowKey(key("c")), { kind: "cancel" });
    assert.deepEqual(dbWindowKey(key("t")), { kind: "tree" });
    assert.deepEqual(dbWindowKey(key("r")), { kind: "refresh" });
    assert.deepEqual(dbWindowKey(key("h")), { kind: "history" });
    assert.deepEqual(dbWindowKey(key("p")), { kind: "elevate" });
    assert.deepEqual(dbWindowKey(key("P", { shiftKey: true })), {
      kind: "elevateEnd",
    });
    assert.deepEqual(dbWindowKey(key("?", { shiftKey: true })), {
      kind: "help",
    });
  });

  it("タブを作る・閉じる・名前を変える・移すキーは持たない（ワークスペースの窓がする）", () => {
    for (const k of ["n", "N", "R", "m", "Tab", "1", "]", "["])
      assert.equal(dbWindowKey(key(k)), null, k);
    assert.equal(dbWindowKey(key("Enter", { shiftKey: true })), null);
  });

  it("Ctrl・Alt・Cmd を重ねたものと、変換中のキーは受けない", () => {
    for (const k of ["j", "x", "Enter", "P", "c"]) {
      assert.equal(dbWindowKey(key(k, { ctrlKey: true })), null);
      assert.equal(dbWindowKey(key(k, { altKey: true })), null);
      assert.equal(dbWindowKey(key(k, { metaKey: true })), null);
      assert.equal(dbWindowKey(key(k, { isComposing: true })), null);
    }
    // macOS：変換を確かめる Enter は isComposing が false で keyCode が 229
    assert.equal(dbWindowKey(key("Enter", { keyCode: 229 })), null);
  });

  it("`?` の一覧の表（placeKeys.ts の dbWindow）のキーを、判定が受ける", () => {
    for (const r of placeKeys().dbWindow.rows)
      for (const p of r.probes)
        assert.notEqual(
          dbWindowKey(key(p, { shiftKey: /^[A-Z?]$/.test(p) })),
          null,
          `${r.keys}: ${p}`,
        );
  });
});

describe("dbWindowHints（窓の下の段の基本操作）", () => {
  const keys = (s: Parameters<typeof dbWindowHints>[0]) =>
    dbWindowHints(s).map((h) => h.keys.join(" "));

  it("ふだんは、選ぶ → 決める → `?` → 閉じる", () => {
    assert.deepEqual(keys({ empty: false }), ["j k", "Enter", "?", "Esc"]);
  });

  it("結果のタブが無い間は、`?` と閉じる Esc だけ", () => {
    assert.deepEqual(keys({ empty: true }), ["?", "Esc"]);
  });
});
