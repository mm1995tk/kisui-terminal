import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Line, Pane, Pos, Range } from "../rpc/protocol.ts";
import {
  cellsFor,
  diagStyle,
  gutterMark,
  gutterNumber,
  gutterText,
  headDiagnostic,
  gutterWidth,
  isCurrentLine,
  layoutLine,
  lineBg,
  lineKey,
  paneCells,
  type Run,
} from "./layout.ts";

function pane(more: Partial<Pane> = {}): Pane {
  return {
    id: "a.go",
    title: { text: "a.go" },
    kind: "text",
    viewport: { top: 0, rows: 10, cols: 20, left: 0, total: 120 },
    curLine: 0,
    cursors: [],
    selections: [],
    lines: [],
    ...more,
  };
}

const at = (line: number, col: number): Pos => ({ line, col });
const range = (s: Pos, e: Pos): Range => ({ start: s, end: e });
const plain = (no: number, text: string): Line => ({
  no,
  spans: [{ text }],
});

/** 区間を「文字列|桁数|印」の短い形にする（読みやすく比べるため）。 */
function show(runs: Run[]): string[] {
  return runs.map((r) => {
    const marks = [
      r.fg,
      r.bg,
      r.cursor && "cursor",
      r.bold && "bold",
      r.diag && `~${r.diag}`,
      r.guide && "guide",
      r.faint && "faint",
    ]
      .filter(Boolean)
      .join(",");
    return `${r.text}|${r.cells}${marks ? `|${marks}` : ""}`;
  });
}

describe("gutter", () => {
  it("幅は全行数の桁数 + 4、番号は 1 始まりで右寄せ", () => {
    assert.equal(gutterWidth(120), 7);
    assert.equal(gutterWidth(9), 5);
    assert.equal(gutterText(0, 120), "    1  ");
    assert.equal(gutterText(0, 120).length, gutterWidth(120));
    assert.equal(gutterText(119, 120), "  120  ");
    assert.equal(gutterText(-1, 120), "       ");
    assert.equal(gutterNumber(0, 120), "   1  ");
    assert.equal(gutterNumber(-1, 120), "      ");
  });

  it("テキストのペインの幅は行番号の欄を足す", () => {
    assert.equal(paneCells(pane()), 27);
    assert.equal(paneCells(pane({ kind: "preview" })), 20);
    // 差分のペインも行番号の欄を持つ（E6）
    assert.equal(paneCells(pane({ kind: "diff" })), 27);
  });
});

describe("layoutLine", () => {
  it("スタイルの区間ごとに分け、色は名前のまま持つ", () => {
    const l: Line = {
      no: 0,
      spans: [
        { text: "func", style: "syntax.keyword", bold: true },
        { text: " main" },
      ],
    };
    assert.deepEqual(show(layoutLine(l, pane(), { cursor: false })), [
      "func|4|syntax.keyword,bold",
      " main|5",
    ]);
  });

  it("タブは次の 4 桁の位置まで空白にし、全角の文字は 1 文字ずつ 2 桁にする", () => {
    const l = plain(0, "a\tあい!");
    assert.deepEqual(show(layoutLine(l, pane(), { cursor: false })), [
      "a   |4",
      "あ|2",
      "い|2",
      "!|1",
    ]);
  });

  it("カーソルはマス目 1 つ。行末にあれば空白を 1 つ足す", () => {
    const p = pane({ cursors: [at(0, 1)] });
    assert.deepEqual(show(layoutLine(plain(0, "abc"), p, { cursor: true })), [
      "a|1",
      "b|1|cursor",
      "c|1",
    ]);
    const end = pane({ cursors: [at(0, 3)] });
    assert.deepEqual(show(layoutLine(plain(0, "abc"), end, { cursor: true })), [
      "abc|3",
      " |1|cursor",
    ]);
    // キーを受けていないペインには描かない
    assert.deepEqual(show(layoutLine(plain(0, "abc"), p, { cursor: false })), [
      "abc|3",
    ]);
    // 別の行のカーソルは描かない
    assert.deepEqual(show(layoutLine(plain(1, "abc"), p, { cursor: true })), [
      "abc|3",
    ]);
  });

  it("タブの上のカーソルは先頭の 1 桁だけ", () => {
    const p = pane({ cursors: [at(0, 0)] });
    assert.deepEqual(show(layoutLine(plain(0, "\tx"), p, { cursor: true })), [
      " |1|cursor",
      "   x|4",
    ]);
  });

  it("選択は [start, end) を塗り、行をまたぐときは行末の 1 桁も塗る", () => {
    const p = pane({ selections: [range(at(0, 1), at(1, 2))] });
    assert.deepEqual(show(layoutLine(plain(0, "abc"), p, { cursor: false })), [
      "a|1",
      "bc |3|selection",
    ]);
    assert.deepEqual(show(layoutLine(plain(1, "xyz"), p, { cursor: false })), [
      "xy|2|selection",
      "z|1",
    ]);
    assert.deepEqual(show(layoutLine(plain(2, "xyz"), p, { cursor: false })), [
      "xyz|3",
    ]);
  });

  it("複数のカーソルと選択", () => {
    const p = pane({
      cursors: [at(0, 0), at(0, 4)],
      selections: [range(at(0, 0), at(0, 0)), range(at(0, 3), at(0, 4))],
    });
    assert.deepEqual(
      show(layoutLine(plain(0, "abcdef"), p, { cursor: true })),
      ["a|1|cursor", "bc|2", "d|1|selection", "e|1|cursor", "f|1"],
    );
  });

  it("横スクロールより左は描かず、幅を超えたら止める", () => {
    const p = pane({
      viewport: { top: 0, rows: 10, cols: 4, left: 2, total: 9 },
    });
    assert.deepEqual(
      show(layoutLine(plain(0, "abcdefgh"), p, { cursor: false })),
      ["cdef|4"],
    );
    // 全角の文字の右半分だけが見えるときは空白、入りきらない全角の文字は描かない
    const q = pane({
      viewport: { top: 0, rows: 10, cols: 4, left: 1, total: 9 },
    });
    assert.deepEqual(
      show(layoutLine(plain(0, "あいう"), q, { cursor: false })),
      [" |1", "い|2"],
    );
  });

  it("テキスト以外のペインにはカーソルと選択を描かない", () => {
    const p = pane({
      kind: "preview",
      cursors: [at(0, 0)],
      selections: [range(at(0, 0), at(0, 2))],
    });
    assert.deepEqual(show(layoutLine(plain(0, "ab"), p, { cursor: true })), [
      "ab|2",
    ]);
  });

  it("span の背景は選択より弱い", () => {
    const l: Line = { no: 0, spans: [{ text: "ab", bg: "md.code.bg" }] };
    const p = pane({ selections: [range(at(0, 1), at(0, 2))] });
    assert.deepEqual(show(layoutLine(l, p, { cursor: false })), [
      "a|1|md.code.bg",
      "b|1|selection",
    ]);
  });
});

describe("lineBg", () => {
  it("カーソルのある行は curline。選択があるときは付けない", () => {
    const p = pane({ curLine: 3 });
    assert.equal(lineBg(plain(3, ""), p), "curline");
    assert.equal(lineBg(plain(2, ""), p), undefined);
    const sel = pane({
      curLine: 3,
      selections: [range(at(3, 0), at(3, 1))],
    });
    assert.equal(lineBg(plain(3, ""), sel), undefined);
    assert.equal(
      lineBg(plain(3, ""), pane({ kind: "preview", curLine: 3 })),
      undefined,
    );
  });
});

describe("cellsFor", () => {
  it("マス目の幅と行の高さで割り、少なくとも 1 にする", () => {
    assert.deepEqual(cellsFor(800, 20 + 22 * 30 + 5, 8), {
      cols: 100,
      rows: 30,
    });
    assert.deepEqual(cellsFor(0, 0, 8), { cols: 1, rows: 1 });
  });
});

describe("lineKey", () => {
  it("別の行のカーソルや選択が動いても変わらず、この行に掛かるものが動けば変わる", () => {
    const l = plain(5, "abc");
    const o = { cursor: true };
    const base = pane({ curLine: 2, cursors: [at(2, 0)] });
    const k = lineKey(l, base, o);
    assert.equal(lineKey(l, pane({ curLine: 3, cursors: [at(3, 1)] }), o), k);
    assert.notEqual(
      lineKey(l, pane({ curLine: 5, cursors: [at(5, 1)] }), o),
      k,
    );
    assert.notEqual(
      lineKey(
        l,
        pane({
          curLine: 2,
          cursors: [at(2, 0)],
          selections: [range(at(4, 0), at(6, 0))],
        }),
        o,
      ),
      k,
    );
    assert.notEqual(
      lineKey(
        l,
        pane({
          curLine: 2,
          viewport: { top: 0, rows: 10, cols: 20, left: 3, total: 120 },
        }),
        o,
      ),
      k,
    );
  });
});

describe("診断（E5）", () => {
  const diagLine = (text: string, diag: Line["diag"]): Line => ({
    no: 0,
    spans: [{ text }],
    diag,
  });

  it("範囲に重さの色の波線を引き、行末の後ろに一番重い文言を薄く出す", () => {
    const l = diagLine("x := y", [
      { start: 5, end: 6, severity: 2, message: "unused" },
      { start: 0, end: 1, severity: 1, message: "undefined: x\nmore" },
    ]);
    const p = pane({
      viewport: { top: 0, rows: 10, cols: 30, left: 0, total: 9 },
    });
    assert.deepEqual(show(layoutLine(l, p, { cursor: false })), [
      "x|1|diag.error,~diag.error",
      " := |4",
      "y|1|diag.warn,~diag.warn",
      "   ● undefined: x|17|diag.error,faint",
    ]);
  });

  it("文字に色があれば色はそのままで、波線だけ引く。重なりは重いほう", () => {
    const l: Line = {
      no: 0,
      spans: [{ text: "ab", style: "syntax.keyword" }],
      diag: [
        { start: 0, end: 2, severity: 3, message: "i" },
        { start: 1, end: 2, severity: 1, message: "e" },
      ],
    };
    const p = pane({
      viewport: { top: 0, rows: 10, cols: 2, left: 0, total: 9 },
    });
    assert.deepEqual(show(layoutLine(l, p, { cursor: false })), [
      "a|1|syntax.keyword,~diag.info",
      "b|1|syntax.keyword,~diag.error",
    ]);
  });

  it("前の行から続く診断だけの行には何も描かない", () => {
    const l = diagLine("ab", [
      { start: 0, end: 3, severity: 1, message: "e", cont: true },
    ]);
    assert.deepEqual(show(layoutLine(l, pane(), { cursor: false })), ["ab|2"]);
  });

  it("文言は幅で切り、空きが 6 桁以下なら出さない", () => {
    const l = diagLine("ab", [
      { start: 0, end: 1, severity: 1, message: "long message" },
    ]);
    const p = (cols: number) =>
      pane({ viewport: { top: 0, rows: 10, cols, left: 0, total: 9 } });
    assert.equal(
      show(layoutLine(l, p(10), { cursor: false })).at(-1),
      "   ● lon|8|diag.error,faint",
    );
    assert.equal(layoutLine(l, p(8), { cursor: false }).length, 2);
  });

  it("重さの色の名前と、文言を出す診断", () => {
    assert.equal(diagStyle(1), "diag.error");
    assert.equal(diagStyle(2), "diag.warn");
    assert.equal(diagStyle(3), "diag.info");
    assert.equal(diagStyle(4), "diag.hint");
    assert.equal(
      headDiagnostic([
        { start: 0, end: 1, severity: 1, message: "c", cont: true },
        { start: 0, end: 1, severity: 3, message: "i" },
        { start: 0, end: 1, severity: 2, message: "w" },
      ])?.message,
      "w",
    );
    assert.equal(headDiagnostic(undefined), undefined);
  });
});

describe("行番号の横の印（E5）", () => {
  it("診断の印は「●」と重さの色。診断の印が無ければ空ける", () => {
    assert.equal(gutterMark(plain(0, "")), undefined);
    assert.deepEqual(
      gutterMark({
        no: 0,
        spans: [],
        marks: [
          { kind: "modified", style: "diff.mod.sign" },
          { kind: "diag", style: "diag.warn" },
        ],
      }),
      { ch: "●", style: "diag.warn" },
    );
    assert.equal(
      gutterMark({
        no: 0,
        spans: [],
        marks: [{ kind: "added", style: "diff.add.sign" }],
      }),
      undefined,
    );
  });
});

describe("インデントガイド（E5）", () => {
  it("guides の桁の空白に引き、indent より右と文字の上には引かない", () => {
    const l: Line = {
      no: 0,
      spans: [{ text: "        x  y" }],
      guides: [0, 4, 9],
      indent: 8,
    };
    assert.deepEqual(show(layoutLine(l, pane(), { cursor: false })), [
      " |1|indent.guide,guide",
      "   |3",
      " |1|indent.guide,guide",
      "   x  y|7",
    ]);
  });

  it("タブは先頭の 1 桁に引く", () => {
    const l: Line = {
      no: 0,
      spans: [{ text: "\t\tx" }],
      guides: [0, 4],
      indent: 8,
    };
    assert.deepEqual(show(layoutLine(l, pane(), { cursor: false })), [
      " |1|indent.guide,guide",
      "   |3|indent.guide",
      " |1|indent.guide,guide",
      "   |3|indent.guide",
      "x|1",
    ]);
  });

  it("空行は行末より右にも indent まで引く。横スクロールより左は描かない", () => {
    const l: Line = { no: 0, spans: [], guides: [0, 4], indent: 8 };
    assert.deepEqual(show(layoutLine(l, pane(), { cursor: false })), [
      " |1|indent.guide,guide",
      "   |3",
      " |1|indent.guide,guide",
      "   |3",
    ]);
    const p = pane({
      viewport: { top: 0, rows: 10, cols: 20, left: 2, total: 9 },
    });
    assert.deepEqual(show(layoutLine(l, p, { cursor: false })), [
      "  |2",
      " |1|indent.guide,guide",
      "   |3",
    ]);
  });

  it("ガイドの上のカーソルはカーソルとして描く", () => {
    const l: Line = {
      no: 0,
      spans: [{ text: "    x" }],
      guides: [0],
      indent: 4,
    };
    const p = pane({ cursors: [at(0, 0)] });
    assert.deepEqual(show(layoutLine(l, p, { cursor: true })), [
      " |1|indent.guide,cursor,guide",
      "   x|4",
    ]);
  });
});

describe("差分（E6）", () => {
  const newSide = (more: Partial<Pane> = {}) =>
    pane({
      kind: "diff",
      diff: { side: "new", top: 0, rows: 10, hunks: [] },
      ...more,
    });
  const oldSide = (more: Partial<Pane> = {}) =>
    pane({
      kind: "diff",
      diff: { side: "old", top: 0, rows: 10, hunks: [] },
      ...more,
    });
  const added: Line = {
    no: 3,
    spans: [{ text: "abcd" }],
    marks: [{ kind: "added", style: "diff.add.sign" }],
    words: [{ start: 1, end: 3 }],
  };
  const deleted: Line = {
    no: 3,
    spans: [{ text: "abcd" }],
    marks: [{ kind: "deleted", style: "diff.del.sign" }],
    words: [{ start: 0, end: 1 }],
  };
  const blank: Line = { no: -1, spans: [], blank: true };

  it("行の背景：変わった行は変更の色、空きは side.bg、ほかはカーソルのある行だけ curline", () => {
    assert.equal(lineBg(added, newSide({ curLine: 3 })), "diff.add.bg");
    assert.equal(lineBg(deleted, newSide({ curLine: 3 })), "diff.del.bg");
    assert.equal(lineBg(blank, newSide()), "side.bg");
    assert.equal(lineBg(plain(3, "x"), newSide({ curLine: 3 })), "curline");
    // 変更の前の側（左の列）はバッファの行ではない
    assert.equal(lineBg(plain(3, "x"), oldSide({ curLine: 3 })), undefined);
  });

  it("カーソルのある行の判定は、消した行と空きと左の列を除く", () => {
    assert.equal(isCurrentLine(plain(3, "x"), newSide({ curLine: 3 })), true);
    assert.equal(isCurrentLine(deleted, newSide({ curLine: 3 })), false);
    assert.equal(isCurrentLine(plain(3, "x"), oldSide({ curLine: 3 })), false);
    assert.equal(isCurrentLine(blank, newSide({ curLine: -1 })), false);
  });

  it("印：消した行は「-」", () => {
    assert.deepEqual(gutterMark(deleted), { ch: "-", style: "diff.del.sign" });
  });

  it("変わった部分：足した側は diff.add.word.bg、消した側は diff.del.word.bg", () => {
    assert.deepEqual(
      layoutLine(added, newSide(), { cursor: false }).map((r) => [
        r.text,
        r.bg,
      ]),
      [
        ["a", undefined],
        ["bc", "diff.add.word.bg"],
        ["d", undefined],
      ],
    );
    assert.deepEqual(
      layoutLine(deleted, newSide(), { cursor: false }).map((r) => [
        r.text,
        r.bg,
      ]),
      [
        ["a", "diff.del.word.bg"],
        ["bcd", undefined],
      ],
    );
    const old: Line = { ...deleted, marks: [] };
    assert.equal(
      layoutLine(old, oldSide(), { cursor: false })[0]?.bg,
      "diff.del.word.bg",
    );
  });

  it("カーソルは今のバッファの行にだけ描く（1 列の差分で消した行の番号が同じでも描かない）", () => {
    const p = newSide({
      cursors: [at(3, 0)],
      selections: [range(at(3, 0), at(3, 0))],
    });
    assert.equal(
      layoutLine(plain(3, "ab"), p, { cursor: true })[0]?.cursor,
      true,
    );
    assert.equal(
      layoutLine(deleted, p, { cursor: true }).some((r) => r.cursor),
      false,
    );
  });
});
