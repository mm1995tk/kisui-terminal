import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import {
  NEW_TAB_KIND_KEYS,
  newTabInputKey,
  newTabKindKey,
  newTabKinds,
  newTabListKey,
} from "./newTabKey.ts";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("タブを作る行の、名前の入力欄のキー", () => {
  it("Tab で次のマシン、Shift+Tab で前のマシンに替える", () => {
    assert.deepEqual(newTabInputKey(key("Tab")), {
      kind: "machine",
      to: "next",
    });
    assert.deepEqual(newTabInputKey(key("Tab", { shiftKey: true })), {
      kind: "machine",
      to: "prev",
    });
    assert.equal(newTabInputKey(key("Tab", { ctrlKey: true })), null);
  });

  it("↓ で一覧を開く。Enter で作り、Esc でやめる", () => {
    assert.deepEqual(newTabInputKey(key("ArrowDown")), { kind: "openList" });
    assert.deepEqual(newTabInputKey(key("Enter")), { kind: "submit" });
    assert.deepEqual(newTabInputKey(key("Escape")), { kind: "cancel" });
  });

  it("押したままのリピートの Enter では作らない（行を出した Enter を押したままでも、空の名前で作らない。#461）", () => {
    assert.equal(newTabInputKey(key("Enter", { repeat: true })), null);
    assert.deepEqual(newTabInputKey(key("Enter", { repeat: false })), {
      kind: "submit",
    });
  });

  it("字（j n N など）は受けない（入力欄にそのまま打てる）", () => {
    for (const k of ["j", "n", "N", "x", " "])
      assert.equal(newTabInputKey(key(k)), null);
  });

  it("変換中のキーでは、決めない・やめない・マシンを替えない・一覧を開かない", () => {
    for (const k of ["Enter", "Escape", "Tab", "ArrowDown"]) {
      assert.equal(newTabInputKey(key(k, { isComposing: true })), null);
      assert.equal(newTabInputKey(key(k, { keyCode: 229 })), null);
    }
  });
});

describe("タブを作る行の、マシンの一覧のキー", () => {
  it("j k と ↓ ↑ で選び、Enter で決め、Esc で一覧だけを閉じる", () => {
    for (const k of ["j", "ArrowDown"])
      assert.deepEqual(newTabListKey(key(k)), { kind: "move", to: "next" });
    for (const k of ["k", "ArrowUp"])
      assert.deepEqual(newTabListKey(key(k)), { kind: "move", to: "prev" });
    assert.deepEqual(newTabListKey(key("Enter")), { kind: "choose" });
    assert.deepEqual(newTabListKey(key("Escape")), { kind: "close" });
  });

  it("ほかのキーと、Ctrl・Cmd・Alt を重ねたものと、変換中のキーは受けない", () => {
    assert.equal(newTabListKey(key("a")), null);
    assert.equal(newTabListKey(key("j", { ctrlKey: true })), null);
    assert.equal(newTabListKey(key("Enter", { keyCode: 229 })), null);
    assert.equal(newTabListKey(key("Escape", { isComposing: true })), null);
  });
});

describe("作るタブの種類を選ぶ一覧のキー（#456）", () => {
  const all = newTabKinds(true);

  it("内蔵ブラウザが無効なら、ブラウザとシークレットは一覧に無い", () => {
    assert.deepEqual(all, ["terminal", "browser", "incognito", "db"]);
    assert.deepEqual(newTabKinds(false), ["terminal", "db"]);
  });

  it("Esc で種類を選ぶのをやめる。選ぶ行は出さないので、j k・矢印・Ctrl+J / Ctrl+K・Enter は受けない", () => {
    assert.deepEqual(newTabKindKey(key("Escape"), all), { kind: "cancel" });
    for (const k of ["j", "k", "ArrowDown", "ArrowUp", "Enter"])
      assert.equal(newTabKindKey(key(k), all), null, k);
    for (const k of ["j", "k"])
      assert.equal(newTabKindKey(key(k, { ctrlKey: true }), all), null, k);
  });

  it("行の字（t・b・B・d）で、その種類に決める", () => {
    assert.deepEqual(newTabKindKey(key("t"), all), {
      kind: "pick",
      what: "terminal",
    });
    assert.deepEqual(newTabKindKey(key("b"), all), {
      kind: "pick",
      what: "browser",
    });
    assert.deepEqual(newTabKindKey(key("B", { shiftKey: true }), all), {
      kind: "pick",
      what: "incognito",
    });
    assert.deepEqual(newTabKindKey(key("d"), all), {
      kind: "pick",
      what: "db",
    });
  });

  it("一覧に出していない種類の字は受けない（内蔵ブラウザが無効なときの b・B）", () => {
    const off = newTabKinds(false);
    assert.equal(newTabKindKey(key("b"), off), null);
    assert.equal(newTabKindKey(key("B", { shiftKey: true }), off), null);
    assert.deepEqual(newTabKindKey(key("t"), off), {
      kind: "pick",
      what: "terminal",
    });
    assert.deepEqual(newTabKindKey(key("d"), off), {
      kind: "pick",
      what: "db",
    });
  });

  it("種類の字は、種類どうしで重ならない", () => {
    const keys = all.map((k) => NEW_TAB_KIND_KEYS[k]);
    assert.equal(new Set(keys).size, keys.length);
  });

  it("ほかの字・Cmd・Ctrl・Alt を重ねたもの・変換中のキーは受けない", () => {
    for (const k of ["n", "N", "x", "r", "h", "l", "?", "Tab"])
      assert.equal(newTabKindKey(key(k), all), null, k);
    assert.equal(newTabKindKey(key("t", { metaKey: true }), all), null);
    assert.equal(newTabKindKey(key("d", { ctrlKey: true }), all), null);
    assert.equal(newTabKindKey(key("b", { altKey: true }), all), null);
    assert.equal(newTabKindKey(key("Enter", { shiftKey: true }), all), null);
    assert.equal(newTabKindKey(key("Enter", { keyCode: 229 }), all), null);
    assert.equal(
      newTabKindKey(key("Escape", { isComposing: true }), all),
      null,
    );
    assert.equal(newTabKindKey(key("t", { isComposing: true }), all), null);
  });
});
