import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { format, isWireMsg, textOf, translate } from "./i18n.ts";

const en = {
  "file.saved": "Saved %s (%d bytes)",
  "ask.close": "close %s? (y/n)",
  quote: "no %q here",
  ch: "[%c] 100%%",
  wrap: "Error: %s",
};
const ja = { "file.saved": "%s を保存しました（%d バイト）" };

describe("textOf", () => {
  it("キーの文に値を埋め、入れ子の文言は先に訳す", () => {
    assert.equal(
      textOf({ key: "file.saved", args: ["a.txt", 12] }, en),
      "Saved a.txt (12 bytes)",
    );
    assert.equal(
      textOf({ key: "file.saved", args: ["a.txt", 12] }, ja),
      "a.txt を保存しました（12 バイト）",
    );
    assert.equal(
      textOf({ key: "wrap", args: [{ key: "ask.close", args: ["x"] }] }, en),
      "Error: close x? (y/n)",
    );
  });
  it("キーが無ければ値をつなぐ。表に無いキーはキーのまま", () => {
    assert.equal(
      textOf({ args: ["n=", { key: "ch", args: [65] }] }, en),
      "n=[A] 100%",
    );
    assert.equal(textOf({ key: "nope", args: [] }, en), "nope");
  });
  it("%q と足りない値", () => {
    assert.equal(
      textOf({ key: "quote", args: ['a"b'] }, en),
      'no "a\\"b" here',
    );
    assert.equal(format("%s %d", ["x"]), "x %!d(MISSING)");
  });
});

describe("translate", () => {
  it("画面の中の文言だけを文字列にする", () => {
    const sc = {
      rev: 1,
      status: {
        msg: { key: "ask.close", args: ["a"] },
        position: "1:1",
        mode: "NOR",
      },
      overlay: [
        { kind: "menu", items: [{ label: { key: "wrap", args: ["x"] } }] },
      ],
      files: { panes: [{ title: { text: "a", key: "k" } }] },
    };
    const out = translate(sc, en);
    assert.equal(out.status.msg, "close a? (y/n)");
    assert.equal(out.status.position, "1:1");
    assert.equal(out.overlay[0]!.items[0]!.label as unknown, "Error: x");
    assert.deepEqual(out.files.panes[0]!.title, { text: "a", key: "k" });
  });
  it("文言の形の判定", () => {
    assert.ok(isWireMsg({ args: [] }));
    assert.ok(isWireMsg({ key: "a", args: [1] }));
    assert.ok(!isWireMsg({ key: "a" }));
    assert.ok(!isWireMsg({ key: "a", args: [], text: "x" }));
    assert.ok(!isWireMsg("a"));
  });
});
