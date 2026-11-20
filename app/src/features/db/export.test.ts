import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DbColumn,
  DbQueryResult,
} from "../../infrastructure/rpc/protocol.ts";
import {
  EXPORT_CHOICES,
  exportFileName,
  exportText,
  field,
  isExportable,
  uniqueKeys,
} from "./export.ts";

const col = (name: string, kind: DbColumn["kind"] = "text"): DbColumn => ({
  name,
  type: "x",
  kind,
});

const result = (
  columns: DbColumn[],
  rows: (string | null)[][],
): DbQueryResult => ({
  columns,
  rows,
  rowCount: rows.length,
  truncated: false,
  elapsedMs: 1,
});

describe("CSV", () => {
  it("見出しの行と値の行を、CRLF で終える", () => {
    const r = result(
      [col("id", "number"), col("name")],
      [
        ["1", "a"],
        ["2", "b"],
      ],
    );
    assert.equal(exportText(r, "csv"), "id,name\r\n1,a\r\n2,b\r\n");
  });

  it('`,` `"` 改行を含む値は囲み、中の `"` は 2 つにする', () => {
    const r = result(
      [col("v")],
      [["a,b"], ['say "hi"'], ["line1\nline2"], ["cr\rx"], ["crlf\r\nx"]],
    );
    assert.equal(
      exportText(r, "csv"),
      'v\r\n"a,b"\r\n"say ""hi"""\r\n"line1\nline2"\r\n"cr\rx"\r\n"crlf\r\nx"\r\n',
    );
  });

  it("見出しの名前にも同じ囲みを使う", () => {
    assert.equal(
      exportText(result([col("a,b"), col('c"d')], []), "csv"),
      '"a,b","c""d"\r\n',
    );
  });

  it('NULL は空のセル、空の文字列は ""（見分けられる）', () => {
    const r = result([col("a"), col("b"), col("c")], [[null, "", "x"]]);
    assert.equal(exportText(r, "csv"), 'a,b,c\r\n,"",x\r\n');
  });

  it("tab や日本語はそのまま、行が 0 でも見出しは出す", () => {
    assert.equal(
      exportText(result([col("名前")], [["a\tb"], ["日本語"]]), "csv"),
      "名前\r\na\tb\r\n日本語\r\n",
    );
    assert.equal(exportText(result([col("a")], []), "csv"), "a\r\n");
  });
});

describe("TSV", () => {
  it("tab 区切り・LF で終える", () => {
    const r = result(
      [col("id"), col("name")],
      [
        ["1", "a b"],
        ["2", "c,d"],
      ],
    );
    assert.equal(exportText(r, "tsv"), "id\tname\n1\ta b\n2\tc,d\n");
  });

  it('tab・`"`・改行を含む値は囲む。`,` は囲まない', () => {
    const r = result(
      [col("v")],
      [["a\tb"], ['q"q'], ["x\ny"], ["p,q"], [null], [""]],
    );
    assert.equal(
      exportText(r, "tsv"),
      'v\n"a\tb"\n"q""q"\n"x\ny"\np,q\n\n""\n',
    );
  });
});

describe("field", () => {
  it("区切りによって、囲むかどうかが変わる", () => {
    assert.equal(field("a,b", ","), '"a,b"');
    assert.equal(field("a,b", "\t"), "a,b");
    assert.equal(field("a\tb", "\t"), '"a\tb"');
    assert.equal(field("a\tb", ","), "a\tb");
  });
});

describe("JSON", () => {
  it("列の名前をキーにしたオブジェクトの配列。数・真偽・NULL は型を付ける", () => {
    const r = result(
      [col("id", "number"), col("ok", "boolean"), col("name"), col("note")],
      [
        ["1", "true", "a", null],
        ["2.50", "false", 'q"\n', ""],
      ],
    );
    const text = exportText(r, "json");
    assert.deepEqual(JSON.parse(text), [
      { id: 1, ok: true, name: "a", note: null },
      { id: 2.5, ok: false, name: 'q"\n', note: "" },
    ]);
    assert.ok(text.endsWith("]\n"));
  });

  it("桁の多い数は、桁を落とさず数のまま書く", () => {
    const r = result(
      [col("id", "number")],
      [["12345678901234567890"], ["-0.000001"], ["1e+30"]],
    );
    const text = exportText(r, "json");
    assert.match(text, /"id": 12345678901234567890\n/);
    assert.match(text, /"id": -0\.000001\n/);
    assert.match(text, /"id": 1e\+30\n/);
  });

  it("JSON の数の書き方に合わない値は、文字のまま", () => {
    const r = result(
      [col("n", "number")],
      [["NaN"], ["Infinity"], ["007"], ["+1"], [".5"]],
    );
    assert.deepEqual(
      JSON.parse(exportText(r, "json")).map((o: { n: unknown }) => o.n),
      ["NaN", "Infinity", "007", "+1", ".5"],
    );
  });

  it("真偽の列でも、true・false 以外は文字のまま。binary は文字", () => {
    const r = result(
      [col("b", "boolean"), col("x", "binary")],
      [["t", "0x00ff"]],
    );
    assert.deepEqual(JSON.parse(exportText(r, "json")), [
      { b: "t", x: "0x00ff" },
    ]);
  });

  it("行が 0 なら空の配列", () => {
    assert.equal(exportText(result([col("a")], []), "json"), "[]\n");
  });

  it("列の名前が重なったら、後の列に番号を付けて値が消えないようにする", () => {
    const r = result(
      [col("a", "number"), col("a", "number"), col("a_2")],
      [["1", "2", "x"]],
    );
    assert.deepEqual(uniqueKeys(r.columns), ["a", "a_2", "a_2_2"]);
    assert.deepEqual(JSON.parse(exportText(r, "json")), [
      { a: 1, a_2: 2, a_2_2: "x" },
    ]);
  });

  it("制御文字・日本語・`__proto__` という名前も壊さない", () => {
    const r = result([col("__proto__"), col("名前")], [["\u0001", "日本語"]]);
    const parsed = JSON.parse(exportText(r, "json"));
    assert.deepEqual(Object.keys(parsed[0]), ["__proto__", "名前"]);
    assert.equal(parsed[0]["名前"], "日本語");
  });
});

describe("書き出しの選び方・ファイル名・書き出せる結果", () => {
  it("形ごとに、クリップボードとファイルの 2 つ（6 通り）", () => {
    assert.deepEqual(
      EXPORT_CHOICES.map((c) => `${c.format}:${c.target}`),
      [
        "csv:clipboard",
        "csv:file",
        "tsv:clipboard",
        "tsv:file",
        "json:clipboard",
        "json:file",
      ],
    );
  });

  it("ファイル名は、接続の名前・この端末の日時・拡張子", () => {
    assert.equal(
      exportFileName("shop", "csv", new Date(2026, 0, 2, 3, 4, 5)),
      "shop-20260102-030405.csv",
    );
    assert.equal(
      exportFileName("shop", "json", new Date(2026, 10, 12, 13, 14, 15)),
      "shop-20261112-131415.json",
    );
  });

  it("列が無い結果（UPDATE など）と結果が無いときは書き出せない。行が 0 でも列があれば書き出せる", () => {
    assert.equal(isExportable(undefined), false);
    assert.equal(isExportable(result([], [])), false);
    assert.equal(isExportable(result([col("a")], [])), true);
  });
});
