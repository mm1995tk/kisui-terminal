import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DbQueryResult } from "../../infrastructure/rpc/protocol.ts";
import { clampRange, inRange, rangeText } from "./selection.ts";

const result: DbQueryResult = {
  columns: [
    { name: "id", type: "int4", kind: "number" },
    { name: "name", type: "text", kind: "text" },
    { name: "note", type: "text", kind: "text" },
  ],
  rows: [
    ["1", "alice", null],
    ["2", "", "a\tb"],
    ["3", 'say "hi"', "line1\nline2"],
  ],
} as DbQueryResult;

const at = (row: number, col: number) => ({ row, col });

describe("rangeText", () => {
  it("1 つのセルは、値そのまま", () => {
    assert.equal(
      rangeText(result, { anchor: at(0, 1), focus: at(0, 1) }),
      "alice",
    );
    assert.equal(
      rangeText(result, { anchor: at(1, 2), focus: at(1, 2) }),
      "a\tb",
    );
  });
  it("1 つの NULL と空の文字列は、空", () => {
    assert.equal(rangeText(result, { anchor: at(0, 2), focus: at(0, 2) }), "");
    assert.equal(rangeText(result, { anchor: at(1, 1), focus: at(1, 1) }), "");
  });
  it("範囲は、列を tab で、行を LF で区切る", () => {
    assert.equal(
      rangeText(result, { anchor: at(0, 0), focus: at(1, 1) }),
      '1\talice\n2\t""',
    );
  });
  it("向きが逆でも同じ", () => {
    assert.equal(
      rangeText(result, { anchor: at(1, 1), focus: at(0, 0) }),
      '1\talice\n2\t""',
    );
  });
  it("2 つ以上のとき、NULL は空、tab・引用符・改行は囲む", () => {
    assert.equal(
      rangeText(result, { anchor: at(0, 2), focus: at(2, 2) }),
      '\n"a\tb"\n"line1\nline2"',
    );
    assert.equal(
      rangeText(result, { anchor: at(2, 0), focus: at(2, 1) }),
      '3\t"say ""hi"""',
    );
  });
});

describe("inRange", () => {
  it("範囲の中だけ true", () => {
    const r = { anchor: at(2, 1), focus: at(0, 0) };
    assert.equal(inRange(r, at(1, 1)), true);
    assert.equal(inRange(r, at(1, 2)), false);
    assert.equal(inRange(null, at(0, 0)), false);
  });
});

describe("clampRange", () => {
  it("表からはみ出したら収める", () => {
    assert.deepEqual(
      clampRange({ anchor: at(0, 0), focus: at(9, 9) }, result),
      {
        anchor: at(0, 0),
        focus: at(2, 2),
      },
    );
  });
  it("行が無ければ null", () => {
    assert.equal(
      clampRange(
        { anchor: at(0, 0), focus: at(0, 0) },
        { ...result, rows: [] },
      ),
      null,
    );
  });
});
