// 内蔵ブラウザのページに入れるスクリプト（app/src-tauri/src/browser_keys.js。#285）が、macOS が矢印キーに使う私用領域の文字
// （U+F700〜U+F74F）の入力だけを止めることを確かめる。ブラウザの代わりに、必要な部分だけを持つ偽物を渡して動かす。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const src = readFileSync(
  new URL("../../../src-tauri/src/browser_keys.js", import.meta.url),
  "utf8",
)
  .replace("__KISUI_NONCE__", '"n"')
  .replace("__KISUI_KEYS__", "[]");

interface Fake {
  isTrusted: boolean;
  inputType: string;
  data: string | null;
  prevented: boolean;
}

/** スクリプトを動かし、beforeinput の受け手を返す。 */
function load(): (e: Fake) => void {
  const listeners: Record<string, (e: Fake) => void> = {};
  class Ev {
    preventDefault(this: Fake) {
      this.prevented = true;
    }
    stopImmediatePropagation() {}
  }
  class KeyboardEvent extends Ev {
    get key() {
      return "";
    }
    get code() {
      return "";
    }
    get ctrlKey() {
      return false;
    }
    get shiftKey() {
      return false;
    }
    get altKey() {
      return false;
    }
    get metaKey() {
      return false;
    }
    get repeat() {
      return false;
    }
    get isComposing() {
      return false;
    }
  }
  class InputEvent extends Ev {
    get inputType() {
      return (this as unknown as Fake).inputType;
    }
    get data() {
      return (this as unknown as Fake).data;
    }
  }
  const win = {
    open() {},
    addEventListener(name: string, f: (e: Fake) => void) {
      listeners[name] = f;
    },
  };
  new Function("window", "Event", "KeyboardEvent", "InputEvent", src)(
    win,
    Ev,
    KeyboardEvent,
    InputEvent,
  );
  return listeners.beforeinput as (e: Fake) => void;
}

describe("矢印キーの豆腐（#285）", () => {
  const onInput = load();
  const run = (inputType: string, data: string | null, trusted = true) => {
    const e = {
      isTrusted: trusted,
      inputType,
      data,
      prevented: false,
    } as Fake;
    onInput(e);
    return e.prevented;
  };

  it("U+F700〜U+F703（上下左右）の入力を止める", () => {
    for (const c of ["\uF700", "\uF701", "\uF702", "\uF703"])
      assert.equal(run("insertText", c), true, c.charCodeAt(0).toString(16));
  });
  it("関数キーの文字の区画 U+F700〜U+F74F の両端を止め、その外（U+F8FF の Apple のロゴなど）は止めない", () => {
    assert.equal(run("insertText", "\uF700"), true);
    assert.equal(run("insertText", "\uF74F"), true);
    assert.equal(run("insertText", "\uF6FF"), false);
    assert.equal(run("insertText", "\uF750"), false);
    assert.equal(run("insertText", "\uF8FF"), false);
  });
  it("普通の文字・日本語・貼り付け・変換中は止めない", () => {
    assert.equal(run("insertText", "a"), false);
    assert.equal(run("insertText", "あ"), false);
    assert.equal(run("insertCompositionText", "\uF700"), false);
    assert.equal(run("insertFromPaste", "\uF700"), false);
    assert.equal(run("insertText", null), false);
  });
  it("ページのスクリプトが作ったイベントには触らない", () => {
    assert.equal(run("insertText", "\uF700", false), false);
  });
});
