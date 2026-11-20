import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitStatements, sqlToRun, statementAt } from "./statements.ts";

const texts = (sql: string) => splitStatements(sql).map((s) => s.text);

describe("splitStatements", () => {
  it("; で区切り、前後の空白と空の文を除く", () => {
    assert.deepEqual(texts("select 1;\n\n select 2 ;;  select 3"), [
      "select 1",
      "select 2",
      "select 3",
    ]);
    assert.deepEqual(texts("  \n "), []);
    assert.deepEqual(texts(";;"), []);
  });

  it("文字列・引用符の名前の中の ; は区切りにしない（'' と \"\" は打ち消し）", () => {
    assert.deepEqual(
      texts(`select 'a;b''c;d'; select "x;""y"; select \`p;q\``),
      [`select 'a;b''c;d'`, `select "x;""y"`, "select `p;q`"],
    );
  });

  it("E'...' の中では \\ が次の字を打ち消す。ふつうの文字列では字", () => {
    assert.deepEqual(texts(`select E'a\\';b'; select 2`), [
      `select E'a\\';b'`,
      "select 2",
    ]);
    assert.deepEqual(texts(`select 'C:\\'; select 2`), [
      `select 'C:\\'`,
      "select 2",
    ]);
  });

  it("コメントの中の ; は区切りにしない（-- と /* */、入れ子も）", () => {
    assert.deepEqual(
      texts("select 1 -- a;b\n; select 2 /* c;d /* e;f */ g;h */"),
      ["select 1 -- a;b", "select 2 /* c;d /* e;f */ g;h */"],
    );
  });

  it("コメントと空白だけの文は含めない", () => {
    assert.deepEqual(texts("select 1; -- 終わり\n/* x */"), ["select 1"]);
  });

  it("$$ と $タグ$ で囲んだ中の ; は区切りにしない", () => {
    assert.deepEqual(
      texts(
        "create function f() returns int as $$ begin select 1; return 1; end $$ language plpgsql; select $fn$a;$$b$fn$; select 3",
      ),
      [
        "create function f() returns int as $$ begin select 1; return 1; end $$ language plpgsql",
        "select $fn$a;$$b$fn$",
        "select 3",
      ],
    );
  });

  it("$1 のような引数と、名前の中の $ は $ で囲む印と見ない", () => {
    assert.deepEqual(texts("select $1; select a$b$c; select 3"), [
      "select $1",
      "select a$b$c",
      "select 3",
    ]);
  });

  it("閉じていない文字列・コメント・$$ は、最後まで 1 つの文", () => {
    assert.deepEqual(texts("select 'a; select 2"), ["select 'a; select 2"]);
    assert.deepEqual(texts("select 1 /* a; b"), ["select 1 /* a; b"]);
    assert.deepEqual(texts("select $$a; b"), ["select $$a; b"]);
  });

  it("from と to は、入力欄の字の位置", () => {
    const sql = "  select 1 ;\n select 2";
    for (const s of splitStatements(sql))
      assert.equal(sql.slice(s.from, s.to), s.text);
  });
});

describe("statementAt", () => {
  const sql = "select 1;\n\nselect 'a;b';\n-- c\nselect 3";
  const at = (n: number) => statementAt(sql, n)?.text;

  it("カーソルのある文", () => {
    assert.equal(at(3), "select 1");
    assert.equal(at(sql.indexOf("a;b") + 2), "select 'a;b'");
    assert.equal(at(sql.length), "-- c\nselect 3".trim());
  });

  it("文の直後（; の次）は、その文。次の行の頭は、次の文", () => {
    assert.equal(at(9), "select 1");
    assert.equal(at(sql.indexOf("select 'a")), "select 'a;b'");
  });

  it("文と文の間（空行）は、上の文。先頭より前は、最初の文", () => {
    assert.equal(at(10), "select 1");
    assert.equal(statementAt("\n\nselect 1", 0)?.text, "select 1");
  });

  it("文が無ければ null", () => {
    assert.equal(statementAt("  ", 1), null);
    assert.equal(statementAt("-- x", 2), null);
  });
});

describe("sqlToRun", () => {
  const sql = "select 1;\nselect 2;\nselect 3";

  it("選んでいなければ、カーソルのある文", () => {
    assert.equal(sqlToRun(sql, 12, 12), "select 2");
  });

  it("選んでいれば、選んだ部分（1 つの文なら ; と空白を除く）", () => {
    assert.equal(sqlToRun(sql, 10, 20), "select 2");
    assert.equal(sqlToRun(sql, 7, 8), "1"); // 文の一部だけでも、選んだ字
    assert.equal(sqlToRun(sql, 20, 10), "select 2"); // 向きは関係ない
  });

  it("選んだ部分に文が 2 つ以上あれば、選んだ字そのまま", () => {
    assert.equal(sqlToRun(sql, 0, 19), "select 1;\nselect 2;");
  });

  it("選んだ部分が空白だけなら空", () => {
    assert.equal(sqlToRun("select 1;   \n", 9, 12), "");
  });
});

describe("MySQL の読み方（opts.mysql）", () => {
  const my = { mysql: true };
  const mtexts = (sql: string) => splitStatements(sql, my).map((s) => s.text);

  it("文字列の中の \\' は打ち消し（後ろの文を巻き込まない）", () => {
    const sql = "select 'it\\'s';\nselect 2;\nselect 3";
    assert.deepEqual(mtexts(sql), ["select 'it\\'s'", "select 2", "select 3"]);
    assert.equal(sqlToRun(sql, sql.length, sql.length, my), "select 3");
    assert.deepEqual(mtexts(`select "a\\"b;c"; select 2`), [
      `select "a\\"b;c"`,
      "select 2",
    ]);
    assert.deepEqual(mtexts("select 'a\\\\'; select 2"), [
      "select 'a\\\\'",
      "select 2",
    ]);
  });

  it("バッククォートの名前の中の \\ は字", () => {
    assert.deepEqual(mtexts("select `a\\`; select 2"), [
      "select `a\\`",
      "select 2",
    ]);
  });

  it("/* */ は入れ子にならない", () => {
    assert.deepEqual(mtexts("/* a /* b */ select 1;\nselect 2"), [
      "/* a /* b */ select 1",
      "select 2",
    ]);
  });

  it("# と、後ろに空白が続く -- はコメント。-- の直後に字が続くのは違う", () => {
    assert.deepEqual(mtexts("select 1 # a;b\n; select 2 -- c;d\n; select 3"), [
      "select 1 # a;b",
      "select 2 -- c;d",
      "select 3",
    ]);
    assert.deepEqual(mtexts("select 1--1; select 2"), [
      "select 1--1",
      "select 2",
    ]);
  });

  it("$$ は囲みではない", () => {
    assert.deepEqual(mtexts("select '$$'; select $$; select 3"), [
      "select '$$'",
      "select $$",
      "select 3",
    ]);
  });

  it("PostgreSQL では、同じ字が別の意味になる", () => {
    assert.deepEqual(texts("select 'a\\'; select 2"), [
      "select 'a\\'",
      "select 2",
    ]);
    assert.deepEqual(texts("select 1 # 2; select 3"), [
      "select 1 # 2",
      "select 3",
    ]);
  });
});
