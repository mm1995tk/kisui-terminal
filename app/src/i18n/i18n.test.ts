import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LANG, lang, setLang, T, tableOf } from "./index.ts";

afterEach(() => setLang(undefined));

const holes = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("画面の文の表", () => {
  it("英語と日本語で、キーが同じ", () => {
    const en = Object.keys(tableOf("en"));
    const ja = Object.keys(tableOf("ja"));
    assert.deepEqual(
      en.filter((k) => !ja.includes(k)),
      [],
      "日本語の表に無いキー",
    );
    assert.deepEqual(
      ja.filter((k) => !en.includes(k)),
      [],
      "英語の表に無いキー",
    );
  });

  it("英語と日本語で、{名前} の穴が同じ", () => {
    const en = tableOf("en");
    const ja = tableOf("ja");
    for (const k of Object.keys(en)) {
      assert.deepEqual(holes(en[k]), holes(ja[k] ?? ""), k);
    }
  });

  it("どの文も空ではない", () => {
    for (const l of ["en", "ja"] as const) {
      for (const [k, v] of Object.entries(tableOf(l))) {
        assert.notEqual(v.trim(), "", `${l}: ${k}`);
      }
    }
  });

  it("英語の表に日本語の字は無い", () => {
    for (const [k, v] of Object.entries(tableOf("en"))) {
      assert.doesNotMatch(v, /[぀-ヿ一-鿿]/, k);
    }
  });

  it("言語が無い・分からない値は英語、ja で日本語", () => {
    assert.equal(DEFAULT_LANG, "en");
    setLang(undefined);
    assert.equal(lang(), "en");
    setLang("fr");
    assert.equal(lang(), "en");
    setLang("ja");
    assert.equal(lang(), "ja");
    setLang("");
    assert.equal(lang(), "en");
  });
});
