// デザインシステムの基礎（tokens.css）の決まりの見張り（#315）。決まりは docs/design/design-system.md。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseTokens, usedVars } from "./tokens.ts";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

const tokens = parseTokens(read("./tokens.css"));
const palette = parseTokens(read("./theme.css"));
const defined = new Set([...tokens, ...palette].map((t) => t.name));

/** 共通の部品の CSS。色・余白・字は tokens.css の名前で書く */
const components = ["../components/card.css", "../components/button.css"];

describe("tokens.css", () => {
  it("値を読み取れる", () => {
    assert.ok(tokens.length > 30);
    assert.ok(tokens.some((t) => t.name === "--color-bg"));
  });

  it("どの値にも、すぐ上に説明があり、見出しの下にある（Storybook の styles/Tokens に出す）", () => {
    for (const t of tokens) {
      assert.notEqual(t.note, "", `${t.name} に説明が無い`);
      assert.notEqual(t.group, "", `${t.name} が見出しの下に無い`);
    }
  });

  it("名前は重ならない", () => {
    const names = tokens.map((t) => t.name);
    assert.deepEqual(names, [...new Set(names)]);
  });

  it("読む名前（パレット・ほかの値）はどれもある", () => {
    for (const t of tokens)
      for (const v of usedVars(t.value))
        assert.ok(defined.has(v), `${t.name} が読む ${v} が無い`);
  });

  it("パレットの色は 16 進の 6 桁（ほかの所は役割の名前で使う）", () => {
    for (const t of palette.filter((t) => t.name !== "--gh-mono"))
      assert.match(t.value, /^#[0-9a-f]{6}$/i, t.name);
  });
});

describe("共通の部品の CSS は tokens.css の名前を使う", () => {
  for (const file of components) {
    const css = read(file);
    const local = new Set(parseTokens(css).map((t) => t.name));

    it(`${file} は色を直に書かない（#… ・rgb() は tokens.css に置く）`, () => {
      const raw = css
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .match(/#[0-9a-f]{3,8}\b|rgba?\(/gi);
      assert.equal(raw, null);
    });

    it(`${file} はパレット（--gh-*）を直に読まない`, () => {
      assert.deepEqual(
        usedVars(css).filter((v) => v.startsWith("--gh-")),
        [],
      );
    });

    it(`${file} が読む名前は、tokens.css かそのファイルの中にある`, () => {
      for (const v of usedVars(css))
        assert.ok(defined.has(v) || local.has(v), `${v} が無い`);
    });
  }
});
