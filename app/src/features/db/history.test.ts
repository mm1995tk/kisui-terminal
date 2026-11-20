import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { atText, filterHistory, sqlPreview } from "./history.ts";

const e = (sql: string, ok = true) => ({
  sql,
  ok,
  at: "2026-01-02T03:04:05.678Z",
});

describe("sqlPreview", () => {
  it("空白と改行を 1 つの空白にたたむ", () => {
    assert.equal(sqlPreview("SELECT *\n  FROM  t\n"), "SELECT * FROM t");
  });

  it("長ければ切って … を付ける（字数で数える）", () => {
    assert.equal(sqlPreview("あいうえお", 3), "あいう…");
    assert.equal(sqlPreview("あいう", 3), "あいう");
  });
});

describe("filterHistory", () => {
  const all = [
    e("SELECT * FROM users"),
    e("delete from Orders"),
    e("SELECT 1"),
  ];

  it("空なら全部、順は変えない", () => {
    assert.deepEqual(filterHistory(all, "  "), all);
  });

  it("大文字小文字を区別せず、空白で区切った語がすべて含まれるものだけ", () => {
    assert.deepEqual(filterHistory(all, "select"), [all[0], all[2]]);
    assert.deepEqual(filterHistory(all, "ORDERS delete"), [all[1]]);
    assert.deepEqual(filterHistory(all, "select orders"), []);
  });
});

describe("atText", () => {
  it("この端末の時刻の 年-月-日 時:分", () => {
    const d = new Date(2026, 0, 2, 3, 4, 5);
    assert.equal(atText(d.toISOString()), "2026-01-02 03:04");
  });

  it("読めない時刻はそのまま", () => {
    assert.equal(atText("not a time"), "not a time");
  });
});
