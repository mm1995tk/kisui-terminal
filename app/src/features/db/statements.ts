// SQL の入力欄の文を `;` で区切る（#375）。DOM にも Solid にも触らない純粋な関数（node --test で確かめられる）。
// 文字列・引用符で囲んだ名前・コメント・PostgreSQL の `$$`（`$タグ$`）で囲んだ中の `;` は、区切りにしない。
// 選んだ部分に文が 2 つ以上あれば、文ごとに上から順に実行する（#380。statementsToRun）。
//
// DB の種類で読み方が違う（opts.mysql）。
// - PostgreSQL（既定）：`\` はふつうの字（`E'...'` の中だけ次の字を打ち消す）・`/* */` は入れ子になる・`$$` で囲める。
// - MySQL：`'...'` と `"..."` の中の `\` が次の字を打ち消す・`/* */` は入れ子にならない・
//   `#` と、後ろに空白が続く `--` が行末までのコメント・`$$` は囲みではない。

/** 区切った文 1 つ。from から to は、前後の空白を除いた文（`;` は含まない。文の前にあるコメントは含む）の字の位置（to は含まない）。 */
export type Statement = {
  from: number;
  to: number;
  /** 文の後の `;` の次の位置（`;` が無い最後の文は sql の長さ）。カーソルの位置から文を選ぶのに使う */
  end: number;
  text: string;
};

const isIdent = (c: string | undefined) =>
  c !== undefined && /[\p{L}\p{N}_$]/u.test(c);

/** i にある `$タグ$` の長さ（タグを開く `$` ではなければ 0）。`$1` のような引数や、`a$$` のような名前の途中は 0。 */
function dollarTagLength(sql: string, i: number): number {
  if (sql[i] !== "$" || isIdent(sql[i - 1])) return 0;
  const m = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(sql.slice(i, i + 200));
  return m ? m[0].length : 0;
}

/** 読み方を決める DB の種類の違い。 */
export type SplitOptions = { mysql?: boolean };

/** sql の `;` で区切った文を、上から順に返す。空の文と、コメントと空白だけの文は含めない。 */
export function splitStatements(
  sql: string,
  opts: SplitOptions = {},
): Statement[] {
  const mysql = opts.mysql === true;
  const out: Statement[] = [];
  let start = 0;
  let code = false; // 今の文に、空白とコメント以外の字があるか

  const push = (semi: number, end: number) => {
    if (code) {
      const text = sql.slice(start, semi).trim();
      const from = start + sql.slice(start, semi).indexOf(text);
      out.push({ from, to: from + text.length, end, text });
    }
    start = end;
    code = false;
  };
  const mark = () => {
    code = true;
  };

  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (
      (c === "-" &&
        next === "-" &&
        (!mysql || /^\s?$/.test(sql[i + 2] ?? ""))) ||
      (mysql && c === "#")
    ) {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl + 1;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (!mysql && sql[i] === "/" && sql[i + 1] === "*") (depth++, (i += 2));
        else if (sql[i] === "*" && sql[i + 1] === "/") (depth--, (i += 2));
        else i++;
      }
    } else if (c === "'" || c === '"' || c === "`") {
      mark();
      // バックスラッシュで次の字を打ち消すのは、MySQL の ' と "、PostgreSQL の E'...'
      const escapes = mysql
        ? c !== "`"
        : c === "'" && /[eE]/.test(sql[i - 1] ?? "") && !isIdent(sql[i - 2]);
      i++;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === c) {
          if (sql[i + 1] === c)
            i += 2; // '' は引用符 1 つの字
          else break;
        } else i++;
      }
      i++; // 閉じる引用符（閉じていなければ末尾）
    } else if (!mysql && c === "$" && dollarTagLength(sql, i) > 0) {
      mark();
      const tag = sql.slice(i, i + dollarTagLength(sql, i));
      const close = sql.indexOf(tag, i + tag.length);
      i = close < 0 ? sql.length : close + tag.length;
    } else if (c === ";") {
      push(i, i + 1);
      i++;
    } else {
      if (!/\s/.test(c)) mark();
      i++;
    }
  }
  push(sql.length, sql.length);
  return out;
}

/**
 * 入力欄の sql で、カーソルのある文を返す（無ければ null：文が 1 つも無い）。
 * カーソルが文と文の間（空行・`;` の後の空白）にあるときは、その上の文（無ければ下の文）。
 * 文の直後（`select 1;` の `;` の次）は、その文。
 */
export function statementAt(
  sql: string,
  cursor: number,
  opts: SplitOptions = {},
): Statement | null {
  const all = splitStatements(sql, opts);
  return (
    all.find((s) => s.from <= cursor && cursor <= s.end) ??
    [...all].reverse().find((s) => s.end < cursor) ??
    all[0] ??
    null
  );
}

/**
 * 実行する文（上から順。#380 で、上から 1 つずつ実行する）。入力欄の sql の、選んでいる範囲（selStart から selEnd）か、
 * 選んでいなければカーソル（selStart）のある文。選んだ部分は `;` で区切り、文ごとに 1 つ（`;` と前後の空白を除く。
 * 文の一部だけを選んだときは、選んだ字）。実行するものが無ければ（空白とコメントだけ）空。
 */
export function statementsToRun(
  sql: string,
  selStart: number,
  selEnd: number,
  opts: SplitOptions = {},
): string[] {
  if (selStart !== selEnd) {
    const sel = sql.slice(
      Math.min(selStart, selEnd),
      Math.max(selStart, selEnd),
    );
    return splitStatements(sel, opts).map((s) => s.text);
  }
  const s = statementAt(sql, selStart, opts);
  return s ? [s.text] : [];
}
