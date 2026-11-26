import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import {
  COMMON_KEYS,
  placeKeys,
  type FooterRow,
} from "../../../features/commands/placeKeys.ts";
import {
  dbWindowFooter,
  dbWindowKey,
  type DbWindowState,
} from "./dbWindowKey.ts";

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

describe("dbWindowFooter（窓の下の段の今効く操作。#487）", () => {
  const all: DbWindowState = {
    selected: true,
    table: true,
    done: true,
    exportable: true,
    running: true,
    elevated: true,
  };
  const none: DbWindowState = {
    selected: false,
    table: false,
    done: false,
    exportable: false,
    running: false,
    elevated: false,
  };
  const shown = (rows: FooterRow[]) =>
    rows.map((r) => [r.title, r.items.map((i) => i.keys.join(" "))]);

  it("全部効くときは、選んでいるタブの行と、この DB のタブの行に、全部の操作を出す", () => {
    assert.deepEqual(shown(dbWindowFooter(all)), [
      ["Selected", ["x", "s", "f b", "e"]],
      ["This DB tab", ["c", "t", "r", "h", "p", "P"]],
    ]);
  });

  it("結果のタブが無く、何も実行しておらず、権限も強めていなければ、選んでいるタブの行は見出しだけで、効く操作だけを出す", () => {
    assert.deepEqual(shown(dbWindowFooter(none)), [
      ["Selected", []],
      ["This DB tab", ["t", "r", "h", "p"]],
    ]);
  });

  it("選んでいる結果のタブの状態に合わせて変わる（テーブルでなければ s、終わっていなければ f b、行が無ければ e を出さない）", () => {
    assert.deepEqual(
      shown(dbWindowFooter({ ...none, selected: true, done: true }))[0],
      ["Selected", ["x", "f b"]],
    );
    // 選んでいなければ、ほかの印があっても出さない
    assert.deepEqual(shown(dbWindowFooter({ ...all, selected: false }))[0], [
      "Selected",
      [],
    ]);
  });

  it("下の段に出す操作は、どれも判定が受ける（案内と受けるキーがずれない）", () => {
    for (const r of dbWindowFooter(all))
      for (const i of r.items)
        for (const p of i.probes)
          assert.notEqual(
            dbWindowKey(key(p, { shiftKey: /^[A-Z?]$/.test(p) })),
            null,
            `${i.keys}: ${p}`,
          );
  });

  it("`?` の一覧の表の操作は、どこでも同じキー（j k・Enter・Esc・`?`）を除き、どれも下の段に出る。下の段には、どこでも同じキーを出さない", () => {
    const probes = dbWindowFooter(all).flatMap((r) =>
      r.items.flatMap((i) => i.probes),
    );
    for (const r of placeKeys().dbWindow.rows)
      for (const p of r.probes)
        if (!COMMON_KEYS.has(p) || p === "h")
          assert.ok(probes.includes(p), `${r.keys}: ${p}`);
    // h は、この窓では履歴（列を移るのではない）なので出す。ほかのどこでも同じキーは出さない
    for (const p of probes) assert.ok(!COMMON_KEYS.has(p) || p === "h", p);
  });
});
