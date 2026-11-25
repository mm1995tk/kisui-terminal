import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import { placeKeys } from "../../../features/commands/placeKeys.ts";
import {
  splitDirKey,
  terminalWindowHints,
  terminalWindowKey,
} from "./terminalWindowKey.ts";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

const DIRS = [
  ["h", "ArrowLeft", "left"],
  ["j", "ArrowDown", "down"],
  ["k", "ArrowUp", "up"],
  ["l", "ArrowRight", "right"],
] as const;

describe("ターミナルのタブの窓のキー", () => {
  it("h j k l と矢印で、選ぶペインを隣へ移す", () => {
    for (const [letter, arrow, dir] of DIRS)
      for (const k of [letter, arrow])
        assert.deepEqual(terminalWindowKey(key(k)), { kind: "select", dir });
  });

  it("H J K L（Shift）で、選んでいるペインを隣と入れ替える", () => {
    for (const [letter, , dir] of DIRS)
      assert.deepEqual(
        terminalWindowKey(key(letter.toUpperCase(), { shiftKey: true })),
        { kind: "swap", dir },
      );
    // Shift+矢印は受けない（入れ替えは字だけ）
    assert.equal(terminalWindowKey(key("ArrowLeft", { shiftKey: true })), null);
  });

  it("Enter はフォーカスを移して閉じ、s は分け、x は閉じ、z は隠し、r はリサイズモード、? は一覧", () => {
    assert.deepEqual(terminalWindowKey(key("Enter")), { kind: "focus" });
    assert.deepEqual(terminalWindowKey(key("s")), { kind: "split" });
    assert.deepEqual(terminalWindowKey(key("x")), { kind: "close" });
    assert.deepEqual(terminalWindowKey(key("z")), { kind: "zoom" });
    assert.deepEqual(terminalWindowKey(key("r")), { kind: "resize" });
    assert.deepEqual(terminalWindowKey(key("?", { shiftKey: true })), {
      kind: "help",
    });
  });

  it("タブを作る・閉じる・名前を変える・移すキーは持たない（ワークスペースの窓がする）", () => {
    for (const k of ["n", "N", "R", "m", "Tab", "1"])
      assert.equal(terminalWindowKey(key(k)), null, k);
    assert.equal(terminalWindowKey(key("Enter", { shiftKey: true })), null);
  });

  it("Ctrl・Alt・Cmd を重ねたものと、変換中のキーは受けない", () => {
    for (const k of ["h", "s", "x", "Enter", "H"]) {
      assert.equal(terminalWindowKey(key(k, { ctrlKey: true })), null);
      assert.equal(terminalWindowKey(key(k, { altKey: true })), null);
      assert.equal(terminalWindowKey(key(k, { metaKey: true })), null);
      assert.equal(terminalWindowKey(key(k, { isComposing: true })), null);
    }
    // macOS：変換を確かめる Enter は isComposing が false で keyCode が 229
    assert.equal(terminalWindowKey(key("Enter", { keyCode: 229 })), null);
  });

  it("`?` の一覧の表（placeKeys.ts の termWindow）のキーを、判定が受ける", () => {
    for (const r of placeKeys().termWindow.rows)
      for (const p of r.probes)
        assert.notEqual(
          terminalWindowKey(key(p, { shiftKey: /^[A-Z?]$/.test(p) })),
          null,
          `${r.keys}: ${p}`,
        );
  });
});

describe("分ける向きを待つ間のキー（s のあと）", () => {
  it("h j k l と矢印で、その向きに分ける", () => {
    for (const [letter, arrow, dir] of DIRS)
      for (const k of [letter, arrow])
        assert.deepEqual(splitDirKey(key(k)), { kind: "dir", dir });
  });

  it("Esc でやめる。変換を取り消す Esc ではやめない", () => {
    assert.deepEqual(splitDirKey(key("Escape")), { kind: "cancel" });
    assert.equal(splitDirKey(key("Escape", { isComposing: true })), null);
    assert.equal(splitDirKey(key("Escape", { keyCode: 229 })), null);
  });

  it("ほかのキーと、修飾キーを重ねたものは受けない", () => {
    for (const k of ["s", "x", "Enter", "?", "z"])
      assert.equal(splitDirKey(key(k)), null, k);
    assert.equal(splitDirKey(key("H", { shiftKey: true })), null);
    assert.equal(splitDirKey(key("h", { ctrlKey: true })), null);
  });
});

describe("terminalWindowHints（窓の下の段の基本操作）", () => {
  const keys = (s: Parameters<typeof terminalWindowHints>[0]) =>
    terminalWindowHints(s).map((h) => h.keys.join(" "));

  it("ふだんは、選ぶ → 決める → `?` → 閉じる", () => {
    assert.deepEqual(keys({ splitting: false, empty: false }), [
      "h j k l",
      "Enter",
      "?",
      "Esc",
    ]);
  });

  it("分ける向きを待つ間は、向きと、やめる Esc だけ", () => {
    assert.deepEqual(keys({ splitting: true, empty: false }), [
      "h j k l",
      "Esc",
    ]);
  });

  it("ペインを出せない間は、閉じる Esc だけ", () => {
    assert.deepEqual(keys({ splitting: false, empty: true }), ["Esc"]);
    assert.deepEqual(keys({ splitting: true, empty: true }), ["Esc"]);
  });
});
