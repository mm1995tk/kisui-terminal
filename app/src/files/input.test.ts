import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cellAt,
  ClickCounter,
  commitParams,
  DOM_DELTA_LINE,
  DOM_DELTA_PAGE,
  DOM_DELTA_PIXEL,
  isGuiKey,
  isMac,
  isPasteKey,
  keyParams,
  type KeyLike,
  modsOf,
  runeOffset,
  WheelAccumulator,
} from "./input.ts";

function key(k: string, more: Partial<KeyLike> = {}): KeyLike {
  return {
    key: k,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...more,
  };
}

describe("keyParams", () => {
  it("文字のキーは key と text に同じ文字を入れる", () => {
    assert.deepEqual(keyParams(key("a"), false), {
      key: "a",
      mods: [],
      phase: "press",
      text: "a",
    });
    assert.deepEqual(keyParams(key("A", { shiftKey: true }), false), {
      key: "A",
      mods: ["shift"],
      phase: "press",
      text: "A",
    });
    assert.equal(keyParams(key(" "), false)?.text, " ");
  });

  it("名前のキーは text を付けず、修飾キーをそのまま送る（Helix のキーは解釈しない）", () => {
    assert.deepEqual(
      keyParams(key("ArrowLeft", { ctrlKey: true, altKey: true }), false),
      { key: "ArrowLeft", mods: ["ctrl", "alt"], phase: "press" },
    );
    assert.deepEqual(keyParams(key("Escape"), false), {
      key: "Escape",
      mods: [],
      phase: "press",
    });
    assert.deepEqual(keyParams(key("s", { metaKey: true }), false)?.mods, [
      "super",
    ]);
  });

  it("macOS の Option で打つ文字は alt を付けない。名前のキーと、ほかの OS は付ける", () => {
    assert.deepEqual(keyParams(key("@", { altKey: true }), true)?.mods, []);
    assert.deepEqual(
      keyParams(key("Backspace", { altKey: true }), true)?.mods,
      ["alt"],
    );
    assert.deepEqual(keyParams(key("x", { altKey: true }), false)?.mods, [
      "alt",
    ]);
  });

  it("押し続けは repeat、離したのは release", () => {
    assert.equal(keyParams(key("j", { repeat: true }), false)?.phase, "repeat");
    assert.equal(keyParams(key("j"), false, "release")?.phase, "release");
  });

  it("修飾キーだけ・dead key・IME の変換中のキーは送らない", () => {
    for (const k of ["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead"])
      assert.equal(keyParams(key(k), false), null, k);
    assert.equal(keyParams(key("a", { isComposing: true }), false), null);
    assert.equal(keyParams(key("a", { keyCode: 229 }), false), null);
    assert.equal(keyParams(key("Process"), false), null);
  });

  it("GUI 自身が受けるキーは送らない", () => {
    assert.equal(
      keyParams(key("T", { ctrlKey: true, shiftKey: true }), false),
      null,
    );
    assert.equal(
      keyParams(
        key("~", { ctrlKey: true, shiftKey: true, code: "Backquote" }),
        false,
      ),
      null,
    );
    // Ctrl+T（Shift なし）は shj に送る
    assert.notEqual(keyParams(key("t", { ctrlKey: true }), false), null);
  });
});

describe("貼り付けのキー", () => {
  it("macOS は Cmd+V、ほかは Ctrl+Shift+V。Ctrl+V は shj に送る", () => {
    assert.ok(isPasteKey(key("v", { metaKey: true }), true));
    assert.ok(!isPasteKey(key("v", { ctrlKey: true }), true));
    assert.ok(isPasteKey(key("V", { ctrlKey: true, shiftKey: true }), false));
    assert.ok(!isPasteKey(key("v", { ctrlKey: true }), false));
    assert.ok(isGuiKey(key("v", { metaKey: true }), true));
    assert.notEqual(keyParams(key("v", { ctrlKey: true }), false), null);
  });

  it("isMac は platform で見分ける", () => {
    assert.ok(isMac("MacIntel"));
    assert.ok(!isMac("Linux x86_64"));
  });
});

describe("IME", () => {
  it("確定した文字は key が Process の input.key にする", () => {
    assert.deepEqual(commitParams("日本語"), {
      key: "Process",
      mods: [],
      text: "日本語",
      phase: "press",
    });
  });

  it("runeOffset は UTF-16 の位置を code point の数にする", () => {
    assert.equal(runeOffset("にほんご", 2), 2);
    assert.equal(runeOffset("𠮷野家", 2), 1); // 𠮷 はサロゲートペア
    assert.equal(runeOffset("𠮷野家", 4), 3);
    assert.equal(runeOffset("abc", -1), 0);
  });
});

describe("マウス", () => {
  it("modsOf は修飾キーを並べる", () => {
    assert.deepEqual(
      modsOf({ ctrlKey: true, shiftKey: true, altKey: true, metaKey: true }),
      ["ctrl", "shift", "alt", "super"],
    );
  });

  it("cellAt は行番号の欄の右から桁を数え、はみ出しは丸めない", () => {
    // マス目 8px、行 22px、行番号の欄 7 桁
    assert.deepEqual(cellAt(8 * 7 + 3, 22 * 2 + 1, 8, 22, 7), {
      row: 2,
      col: 0,
    });
    assert.deepEqual(cellAt(8 * 10, 0, 8, 22, 7), { row: 0, col: 3 });
    // 行番号の欄の上は負の桁（core が 0 にする）
    assert.deepEqual(cellAt(4, 5, 8, 22, 7), { row: 0, col: -7 });
    // 上にはみ出したドラッグは負の行（core が上へスクロールする）
    assert.deepEqual(cellAt(-10, -30, 8, 22, 0), { row: -2, col: -2 });
  });

  it("ClickCounter は同じ所を続けて押すと 2、3 と数え、そのあと 1 に戻る", () => {
    const c = new ClickCounter(400);
    assert.equal(c.press(0, 0, "a", 1, 2), 1);
    assert.equal(c.press(100, 0, "a", 1, 2), 2);
    assert.equal(c.press(200, 0, "a", 1, 2), 3);
    assert.equal(c.press(300, 0, "a", 1, 2), 1);
  });

  it("ClickCounter は間が空く・別の所・別のボタンなら 1 から", () => {
    const c = new ClickCounter(400);
    c.press(0, 0, "a", 1, 2);
    assert.equal(c.press(500, 0, "a", 1, 2), 1);
    assert.equal(c.press(600, 0, "a", 1, 3), 1);
    assert.equal(c.press(700, 2, "a", 1, 3), 1);
    assert.equal(c.press(800, 2, "b", 1, 3), 1);
  });

  it("WheelAccumulator は px を行と桁にし、端数を持ち越す", () => {
    const w = new WheelAccumulator();
    const size = { cellWidth: 8, lineHeight: 20, rows: 30, cols: 80 };
    assert.deepEqual(w.add(0, 10, DOM_DELTA_PIXEL, size), { dx: 0, dy: 0 });
    assert.deepEqual(w.add(0, 30, DOM_DELTA_PIXEL, size), { dx: 0, dy: 2 });
    assert.deepEqual(w.add(-16, 0, DOM_DELTA_PIXEL, size), { dx: -2, dy: 0 });
    assert.deepEqual(w.add(0, -3, DOM_DELTA_LINE, size), { dx: 0, dy: -3 });
    assert.deepEqual(w.add(0, 1, DOM_DELTA_PAGE, size), { dx: 0, dy: 30 });
  });
});
