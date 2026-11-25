import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KeyLike } from "../../../features/commands/guiKeys.ts";
import { newTabInputKey } from "./newTabKey.ts";
import { PLACE_KEYS } from "../../../features/commands/placeKeys.ts";
import {
  confirmKey,
  holdHints,
  holdKey,
  newTabInputHints,
  switcherHints,
  switcherKey,
} from "./switcherKey.ts";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("ワークスペースを切り替える窓のキー", () => {
  it("j k と矢印と Ctrl+J / Ctrl+K で、選ぶ行を動かす", () => {
    for (const k of ["j", "ArrowDown"])
      assert.deepEqual(switcherKey(key(k)), { kind: "move", to: "next" });
    for (const k of ["k", "ArrowUp"])
      assert.deepEqual(switcherKey(key(k)), { kind: "move", to: "prev" });
    assert.deepEqual(switcherKey(key("j", { ctrlKey: true })), {
      kind: "move",
      to: "next",
    });
    assert.deepEqual(switcherKey(key("k", { ctrlKey: true })), {
      kind: "move",
      to: "prev",
    });
  });

  it("h l と矢印の左右で、キーが効く列を移る", () => {
    for (const k of ["h", "ArrowLeft"])
      assert.deepEqual(switcherKey(key(k)), { kind: "col", to: "ws" });
    for (const k of ["l", "ArrowRight"])
      assert.deepEqual(switcherKey(key(k)), { kind: "col", to: "tab" });
    assert.equal(switcherKey(key("h", { ctrlKey: true })), null);
    assert.equal(switcherKey(key("l", { metaKey: true })), null);
    assert.equal(switcherKey(key("l", { altKey: true })), null);
    assert.equal(switcherKey(key("h", { isComposing: true })), null);
    assert.equal(switcherKey(key("l", { keyCode: 229 })), null);
  });

  it("Enter で開く。Tab と 1〜9 は受けない（j k で選ぶ）", () => {
    assert.deepEqual(switcherKey(key("Enter")), { kind: "go" });
    assert.equal(switcherKey(key("Tab")), null);
    assert.equal(switcherKey(key("1")), null);
    assert.equal(switcherKey(key("9")), null);
  });

  it("n は作り、r は名前を変え、x は閉じる", () => {
    assert.deepEqual(switcherKey(key("n")), { kind: "new" });
    assert.deepEqual(switcherKey(key("r")), { kind: "rename" });
    assert.deepEqual(switcherKey(key("x")), { kind: "close" });
    assert.equal(switcherKey(key("x", { ctrlKey: true })), null);
    assert.equal(switcherKey(key("n", { metaKey: true })), null);
  });

  it("N（Shift+n）は、どちらの列でもタブを作る（種類を選ぶ一覧を出す）。Cmd・Ctrl・Alt を重ねたものと変換中のキーは受けない", () => {
    assert.deepEqual(switcherKey(key("N", { shiftKey: true })), {
      kind: "newTab",
    });
    assert.equal(switcherKey(key("N", { metaKey: true })), null);
    assert.equal(switcherKey(key("N", { ctrlKey: true })), null);
    assert.equal(switcherKey(key("N", { isComposing: true })), null);
    assert.equal(switcherKey(key("N", { keyCode: 229 })), null);
  });

  it("J K（Shift+j・Shift+k）は並べ替える", () => {
    assert.deepEqual(switcherKey(key("J", { shiftKey: true })), {
      kind: "reorder",
      dir: "down",
    });
    assert.deepEqual(switcherKey(key("K", { shiftKey: true })), {
      kind: "reorder",
      dir: "up",
    });
  });

  it("絞り込みの字は受けず、Alt・Cmd を重ねたものと変換中のキーは受けない", () => {
    assert.equal(switcherKey(key("a")), null);
    assert.equal(switcherKey(key("q")), null);
    assert.equal(switcherKey(key("x", { altKey: true })), null);
    assert.equal(switcherKey(key("j", { metaKey: true })), null);
    assert.equal(switcherKey(key("Enter", { shiftKey: true })), null);
    assert.equal(switcherKey(key("j", { isComposing: true })), null);
    // 変換を確定する Enter（compositionend のあとに keyCode 229 で来る）で移らない
    assert.equal(switcherKey(key("Enter", { keyCode: 229 })), null);
    assert.equal(switcherKey(key("Process", { keyCode: 229 })), null);
  });
});

describe("閉じる確認のキー", () => {
  it("y で閉じ、n でやめる。ほかのキーと、Ctrl・Cmd・Alt を重ねたものと、変換中のキーは何もしない", () => {
    assert.equal(confirmKey(key("y")), "yes");
    assert.equal(confirmKey(key("n")), "no");
    assert.equal(confirmKey(key("x")), null);
    assert.equal(confirmKey(key("Enter")), null);
    assert.equal(confirmKey(key("y", { ctrlKey: true })), null);
    assert.equal(confirmKey(key("y", { isComposing: true })), null);
    assert.equal(confirmKey(key("n", { keyCode: 229 })), null);
  });
});

describe("窓の下の段（共通フッタ）の基本操作", () => {
  const keys = (col: "ws" | "tab", hasTabs: boolean) =>
    switcherHints(col, hasTabs).flatMap((h) => h.keys);

  it("ワークスペースの列では、選ぶ・タブの列へ・移る・`?`・閉じるだけを、この順に出す。タブが無ければ l は出さない", () => {
    assert.deepEqual(keys("ws", true), ["j", "k", "l", "Enter", "?", "Esc"]);
    assert.deepEqual(keys("ws", false), ["j", "k", "Enter", "?", "Esc"]);
  });

  it("タブの列では、選ぶ・ワークスペースの列へ・タブを出す・`?`・閉じるだけを、この順に出す", () => {
    assert.deepEqual(keys("tab", true), ["j", "k", "h", "Enter", "?", "Esc"]);
  });

  it("下の段に出すキーは、どれも判定が受ける（Esc は窓が受ける）", () => {
    for (const col of ["ws", "tab"] as const)
      for (const k of keys(col, true))
        if (k !== "Esc")
          assert.notEqual(switcherKey(key(k)), null, `${col}: ${k}`);
  });

  it("タブ名の入力欄にいる間は、欄の中で効くキー（Tab・Enter・Esc）だけを出し、j k や `?` は出さない。どれも欄の判定が受ける", () => {
    const keys = newTabInputHints().flatMap((h) => h.keys);
    assert.deepEqual(keys, ["Tab", "Enter", "Esc"]);
    for (const k of keys)
      assert.notEqual(newTabInputKey(key(k === "Esc" ? "Escape" : k)), null, k);
  });

  it("つかんでいる間は、つかんでいる間のキーだけを出し（`?` は出さない）、どれも判定が受ける", () => {
    const held = holdHints().flatMap((h) => h.keys);
    assert.deepEqual(held, ["j", "k", "h", "l", "Enter", "Esc"]);
    for (const k of held)
      assert.notEqual(holdKey(key(k === "Esc" ? "Escape" : k)), null, k);
    assert.equal(holdKey(key("?", { shiftKey: true })), null);
  });
});

describe("`?` の一覧の表（placeKeys.ts の switcher・switcherTabs）", () => {
  it("`?` で、キーの一覧を出す（Ctrl・Cmd・Alt を重ねたものと変換中は受けない）", () => {
    assert.deepEqual(switcherKey(key("?", { shiftKey: true })), {
      kind: "help",
    });
    assert.equal(switcherKey(key("?", { ctrlKey: true })), null);
    assert.equal(switcherKey(key("?", { isComposing: true })), null);
  });

  it("表のキーは、どれも判定が受ける", () => {
    for (const place of ["switcher", "switcherTabs"] as const)
      for (const r of PLACE_KEYS[place].rows)
        for (const p of r.probes)
          assert.notEqual(
            switcherKey(key(p)),
            null,
            `${place} ${r.keys}: ${p}`,
          );
  });

  it("判定が受ける字のキーは、どちらかの列の表にある（表から漏れた操作が無い）", () => {
    const listed = new Set(
      (["switcher", "switcherTabs"] as const).flatMap((place) =>
        PLACE_KEYS[place].rows.flatMap((r) => r.probes),
      ),
    );
    for (const k of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ?")
      if (switcherKey(key(k)) !== null) assert.ok(listed.has(k), k);
  });

  it("下の段に出すキーは、その列の表にもある（下の段は表の一部）", () => {
    const of = (place: "switcher" | "switcherTabs") =>
      new Set(PLACE_KEYS[place].rows.flatMap((r) => r.keys.split(/[ /]+/)));
    for (const k of switcherHints("ws", true).flatMap((h) => h.keys))
      assert.ok(of("switcher").has(k), `ws: ${k}`);
    for (const k of switcherHints("tab", true).flatMap((h) => h.keys))
      assert.ok(of("switcherTabs").has(k), `tab: ${k}`);
  });
});

describe("タブをつかむ（m）", () => {
  it("m は、つかむ（Cmd・Ctrl・Alt を重ねたものと変換中は受けない）", () => {
    assert.deepEqual(switcherKey(key("m")), { kind: "hold" });
    assert.equal(switcherKey(key("m", { ctrlKey: true })), null);
    assert.equal(switcherKey(key("m", { metaKey: true })), null);
    assert.equal(switcherKey(key("m", { isComposing: true })), null);
  });
});

describe("タブをつかんでいる間のキー", () => {
  it("j k・矢印・Ctrl+J / Ctrl+K で動かす", () => {
    for (const k of ["j", "ArrowDown"])
      assert.deepEqual(holdKey(key(k)), { kind: "move", to: "next" });
    for (const k of ["k", "ArrowUp"])
      assert.deepEqual(holdKey(key(k)), { kind: "move", to: "prev" });
    assert.deepEqual(holdKey(key("j", { ctrlKey: true })), {
      kind: "move",
      to: "next",
    });
    assert.deepEqual(holdKey(key("k", { ctrlKey: true })), {
      kind: "move",
      to: "prev",
    });
  });

  it("h l と矢印の左右で、列を移る", () => {
    for (const k of ["h", "ArrowLeft"])
      assert.deepEqual(holdKey(key(k)), { kind: "col", to: "ws" });
    for (const k of ["l", "ArrowRight"])
      assert.deepEqual(holdKey(key(k)), { kind: "col", to: "tab" });
  });

  it("Enter と m で落とし、Esc でやめる", () => {
    assert.deepEqual(holdKey(key("Enter")), { kind: "drop" });
    assert.deepEqual(holdKey(key("m")), { kind: "drop" });
    assert.deepEqual(holdKey(key("Escape")), { kind: "cancel" });
    assert.equal(holdKey(key("Enter", { shiftKey: true })), null);
  });

  it("ほかのキーは受けない（並べ替え・作る・名前を変える・閉じる・Tab）", () => {
    for (const k of ["J", "K", "n", "N", "r", "x", "y", "Tab", "1"])
      assert.equal(holdKey(key(k)), null, k);
  });

  it("Cmd・Alt を重ねたものと、変換中のキーは受けない", () => {
    assert.equal(holdKey(key("j", { metaKey: true })), null);
    assert.equal(holdKey(key("h", { altKey: true })), null);
    assert.equal(holdKey(key("Escape", { ctrlKey: true })), null);
    assert.equal(holdKey(key("Escape", { isComposing: true })), null);
    assert.equal(holdKey(key("Enter", { keyCode: 229 })), null);
    assert.equal(holdKey(key("j", { isComposing: true })), null);
  });
});
