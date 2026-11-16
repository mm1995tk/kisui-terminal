import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { isComposingKey } from "./ime.ts";

describe("isComposingKey", () => {
  it("変換中のキー（isComposing）は変換のキー", () => {
    assert.equal(isComposingKey({ key: "Enter", isComposing: true }), true);
    assert.equal(isComposingKey({ key: "Escape", isComposing: true }), true);
    assert.equal(isComposingKey({ key: "a", isComposing: true }), true);
  });

  it("compositionend の後に keyCode 229 で来る、変換を確定する Enter も変換のキー（macOS の WKWebView）", () => {
    assert.equal(
      isComposingKey({ key: "Enter", isComposing: false, keyCode: 229 }),
      true,
    );
    assert.equal(isComposingKey({ key: "Enter", keyCode: 229 }), true);
  });

  it("key が Process のキーも変換のキー", () => {
    assert.equal(isComposingKey({ key: "Process", keyCode: 13 }), true);
    assert.equal(isComposingKey({ key: "Process" }), true);
  });

  it("変換をしていない Enter・Esc・字は変換のキーではない", () => {
    assert.equal(isComposingKey({ key: "Enter" }), false);
    assert.equal(isComposingKey({ key: "Enter", keyCode: 13 }), false);
    assert.equal(
      isComposingKey({ key: "Escape", isComposing: false, keyCode: 27 }),
      false,
    );
    assert.equal(isComposingKey({ key: "a", keyCode: 65 }), false);
  });
});

// 入力欄やキーの判定を足した人が、変換のキーを isComposing だけで見分けて、同じ不具合（#172・#298）を繰り返さないための見張り。
describe("app/src のキーの判定は isComposingKey を使う", () => {
  const root = new URL("./", import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .filter((f) => f !== "ime.ts")
    .sort();

  it("app/src の .ts・.tsx を読んでいる", () => {
    assert.ok(files.includes("App.tsx"));
    assert.ok(files.includes("commands.ts"));
  });

  for (const file of files) {
    const src = readFileSync(new URL(file, root), "utf8");

    it(`${file} は isComposing・keyCode を直に読まない（ime.ts の isComposingKey を使う）`, () => {
      const reads = src
        .split("\n")
        .filter((l) => /\.(isComposing|keyCode)\b/.test(l));
      assert.deepEqual(reads, []);
    });

    // Enter・Esc は、変換の確定・取り消しにも使うキー。これを見るファイルは、変換のキーを isComposingKey で除く
    if (
      /\.key\s*[!=]==?\s*"(Enter|Escape)"|case\s+"(Enter|Escape)":/.test(src)
    ) {
      it(`${file} は Enter・Esc を見るので、isComposingKey で変換のキーを除く`, () => {
        assert.match(src, /\bisComposingKey\(/);
      });
    }
  }
});
