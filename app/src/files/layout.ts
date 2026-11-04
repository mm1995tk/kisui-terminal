// ペインの 1 行を、等幅のマス目に並べる「区間（Run）」に分ける。色はまだテーマ上の名前のまま。
// TUI の描き方（ui/tui/editor_draw.go の lineDrawer）に合わせる：
//  - 行番号の欄（gutter）は「印の 1 桁 + 右寄せの番号 + 空き 2 桁」で、幅は全行数の桁数 + 4。
//    印の桁には、診断のある行に診断の重さの色の「●」を出す（gutterMark）。
//  - カーソルのある行は curline の背景。ただし選択があるときは付けない。
//  - 選択は selection の背景。範囲は [start, end)。行末より右も、選択が行をまたぐときは 1 桁塗る。
//  - カーソルはマス目 1 つ（タブの上では先頭の 1 桁）を cursor の色で塗り、文字を cursor.fg で描く。
//  - 横スクロール（viewport.left）より左は描かず、幅（viewport.cols）を超えたら止める。
//  - 診断（E5）：その行で始まる診断があれば、診断の範囲に重さの色の下線を引き、行末の後ろに一番重い診断の
//    文言の 1 行目を薄く出す。前の行から続く診断（cont）だけの行には何も描かない。
//  - インデントガイド（E5）：guides の桁にある空白（タブは先頭の 1 桁）に縦線を引く。indent より右には
//    引かない。空行は行末より右にも indent まで引く。縦線は文字ではなく、マス目の左端の 1px の線
//    （モックのツリーの縦線と同じ形）で描く。
//  - 差分（E6。ui/tui/gitdiff_draw.go）：差分のペインも行番号の欄を持つ。消した行（左の列の行と、
//    1 列の差分で消した行）は diff.del.bg の背景で、印の桁に「-」を出す。足した・書き換えた行は
//    diff.add.bg の背景。行の中の変わった部分（words）は、消した側は diff.del.word.bg、足した側は
//    diff.add.word.bg。相手側にだけ行がある空き（blank）は side.bg で塗る。カーソル・選択・行の強調は、
//    今のバッファの行（変更の後の側の、消した行でも空きでもない行）にだけ描く。
// 行の文字はスタイルの区間（spans）で来るので、ここで rune（code point）に戻して数える。

import type {
  Diagnostic,
  Line,
  Pane,
  Pos,
  Range,
  Severity,
} from "../rpc/protocol.ts";
import { runeWidth } from "./width.ts";

/** 同じ見た目で続くマス目の区間。 */
export interface Run {
  text: string;
  /** 使うマス目の数（全角 1 文字なら 2） */
  cells: number;
  /** 文字の色の名前。undefined は標準の文字色（editor.fg） */
  fg?: string;
  /** 背景の色の名前。undefined は行の背景 */
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** カーソルのマス目 */
  cursor?: boolean;
  /** 診断の波線の色の名前 */
  diag?: string;
  /** インデントガイドのマス目（左端に縦線を引く。1 桁で、ほかの区間とまとめない） */
  guide?: boolean;
  /** 薄く描く（行末の診断の文言） */
  faint?: boolean;
}

/** 描き方の選択。 */
export interface LineOptions {
  /** カーソルを描くか（キーを受けているペインだけ） */
  cursor: boolean;
}

/** 行番号の欄の幅（マス目）。shj の core.GutterWidthFor と同じ。 */
export function gutterWidth(total: number): number {
  return String(Math.max(0, total)).length + 4;
}

/** 行番号の欄の文字（印の 1 桁は空き）。no はバッファの行番号（0 始まり）。 */
export function gutterText(no: number, total: number): string {
  return ` ${gutterNumber(no, total)}`;
}

/** 行番号の欄のうち、印の 1 桁を除いた残り（右寄せの番号 + 空き 2 桁）。no が負なら空白。 */
export function gutterNumber(no: number, total: number): string {
  const w = gutterWidth(total) - 1;
  if (no < 0) return " ".repeat(w);
  return `${String(no + 1).padStart(w - 2)}  `;
}

/** 行番号の欄を持つペイン（テキストと差分）。 */
export function hasGutter(p: Pane): boolean {
  return p.kind === "text" || p.kind === "diff";
}

/** ペインの行番号の欄の幅（マス目）。欄が無ければ 0。 */
export function paneGutter(p: Pane): number {
  return hasGutter(p) ? gutterWidth(p.viewport.total) : 0;
}

/** ペインの横幅（マス目）。テキストと差分は行番号の欄を足す。 */
export function paneCells(p: Pane): number {
  return Math.max(0, p.viewport.cols) + paneGutter(p);
}

/** 差分で、変更の前の行（1 列の差分で消した行）。 */
export function isDeletedLine(l: Line): boolean {
  return (l.marks ?? []).some((m) => m?.kind === "deleted");
}

/** 差分で、変更の後の側の変わった行（足した・書き換えた行）。 */
export function isChangedLine(l: Line): boolean {
  return (l.marks ?? []).some(
    (m) => m?.kind === "added" || m?.kind === "modified",
  );
}

/**
 * 今のバッファの行か（カーソル・選択・行の強調を描く行）。テキストの行と、差分の変更の後の側のうち、
 * 消した行でも空きでもない行。
 */
export function isBufferLine(line: Line, p: Pane): boolean {
  if (line.no < 0) return false;
  if (p.kind === "text") return true;
  return (
    p.kind === "diff" &&
    p.diff?.side !== "old" &&
    !line.blank &&
    !isDeletedLine(line)
  );
}

/** カーソルのある行か（行番号を強調する）。 */
export function isCurrentLine(line: Line, p: Pane): boolean {
  return isBufferLine(line, p) && line.no === p.curLine;
}

/** 消した側の行か（左の列の行と、1 列の差分で消した行）。 */
function oldSide(line: Line, p: Pane): boolean {
  return p.kind === "diff" && (p.diff?.side === "old" || isDeletedLine(line));
}

/**
 * 行の背景の名前。カーソルのある行は curline（選択があるときは付けない）。
 * 差分は変更の背景を、カーソルのある行でも優先する（TUI と同じ）。
 */
export function lineBg(line: Line, p: Pane): string | undefined {
  if (line.band) return line.band;
  if (p.kind === "diff") {
    if (line.blank) return "side.bg";
    if (isDeletedLine(line)) return "diff.del.bg";
    if (isChangedLine(line)) return "diff.add.bg";
  }
  if (!isCurrentLine(line, p)) return undefined;
  return hasSelection(p.selections) ? undefined : "curline";
}

function hasSelection(sel: readonly Range[] | null | undefined): boolean {
  const s = sel?.[0];
  return !!s && (s.start.line !== s.end.line || s.start.col !== s.end.col);
}

function before(a: Pos, b: Pos): boolean {
  return a.line < b.line || (a.line === b.line && a.col < b.col);
}

/** 診断の重さの色の名前（Go の core.DiagStyle）。 */
export function diagStyle(sev: Severity | number): string {
  switch (sev) {
    case 2:
      return "diag.warn";
    case 3:
      return "diag.info";
    case 4:
      return "diag.hint";
  }
  return "diag.error";
}

/** 行末に文言を出す診断。続きでない診断のうち一番重いもの（Go の core.HeadDiagnostic）。 */
export function headDiagnostic(
  ds: readonly Diagnostic[] | null | undefined,
): Diagnostic | undefined {
  let best: Diagnostic | undefined;
  for (const d of ds ?? []) {
    if (d.cont) continue;
    if (!best || d.severity < best.severity) best = d;
  }
  return best;
}

/** 行番号の横の印（1 桁の文字と色の名前）。 */
export interface GutterMark {
  ch: string;
  style: string;
}

/**
 * 行番号の横の印。印が無ければ undefined（印の桁は空ける）。
 * 診断の印は「●」、差分で消した行は「-」（TUI の drawOldLine と同じ）。足した・書き換えた行は背景だけで
 * 印は出さない（TUI と同じ。どこが変わったかは変更のバーにも出る）。
 */
export function gutterMark(line: Line): GutterMark | undefined {
  const diag = line.marks?.find((m) => m.kind === "diag");
  if (diag?.style) return { ch: "●", style: diag.style };
  const del = line.marks?.find((m) => m.kind === "deleted");
  if (del) return { ch: "-", style: del.style || "diff.del.sign" };
  return undefined;
}

/** 1 つのマス目の見た目。 */
type Cell = Omit<Run, "text" | "cells"> & { ch: string; cells: number };

function sameLook(a: Run, b: Cell): boolean {
  if (a.cursor || b.cursor || a.guide || b.guide) return false;
  const eq = (x: unknown, y: unknown) => (x || undefined) === (y || undefined);
  return (
    eq(a.fg, b.fg) &&
    eq(a.bg, b.bg) &&
    eq(a.bold, b.bold) &&
    eq(a.italic, b.italic) &&
    eq(a.underline, b.underline) &&
    eq(a.strike, b.strike) &&
    eq(a.diag, b.diag) &&
    eq(a.faint, b.faint)
  );
}

function runOf(c: Cell): Run {
  const r: Run = { text: c.ch, cells: c.cells };
  if (c.fg) r.fg = c.fg;
  if (c.bg) r.bg = c.bg;
  if (c.bold) r.bold = true;
  if (c.italic) r.italic = true;
  if (c.underline) r.underline = true;
  if (c.strike) r.strike = true;
  if (c.cursor) r.cursor = true;
  if (c.diag) r.diag = c.diag;
  if (c.guide) r.guide = true;
  if (c.faint) r.faint = true;
  return r;
}

/** 行の文字を rune に分け、rune ごとにスタイルの区間の見た目を付ける。 */
function runeLooks(line: Line): Cell[] {
  const out: Cell[] = [];
  for (const sp of line.spans ?? []) {
    for (const ch of sp.text) {
      out.push({
        ch,
        cells: 1,
        fg: sp.style || undefined,
        bg: sp.bg || undefined,
        bold: sp.bold,
        italic: sp.italic,
        underline: sp.underline,
        strike: sp.strike,
      });
    }
  }
  return out;
}

/** rune の位置 col に掛かる一番重い診断の色。その行で始まる診断が無い行には引かない（TUI と同じ）。 */
function diagAt(line: Line, col: number): string | undefined {
  if (!headDiagnostic(line.diag)) return undefined;
  let best: Diagnostic | undefined;
  for (const d of line.diag ?? []) {
    if (col >= d.start && col < d.end && (!best || d.severity < best.severity))
      best = d;
  }
  return best && diagStyle(best.severity);
}

/** インデントガイドを引く桁か。 */
function guideCol(line: Line): (v: number) => boolean {
  const w = line.indent ?? 0;
  const guides = new Set(line.guides ?? []);
  return (v) => v < w && guides.has(v);
}

/**
 * 空行のガイドを、行末（表示上の桁 vis）より右に indent まで引く。from より左（横スクロール）は描かず、
 * room 桁を超えない。bg は行末より右の背景。
 */
function tailGuides(
  line: Line,
  vis: number,
  from: number,
  room: number,
  bg: string | undefined,
): Cell[] {
  const isGuide = guideCol(line);
  const out: Cell[] = [];
  for (let v = Math.max(vis, from); v < (line.indent ?? 0); v++) {
    if (out.length >= room) break;
    const guide = isGuide(v);
    out.push({
      ch: " ",
      cells: 1,
      bg,
      fg: guide ? "indent.guide" : undefined,
      guide,
    });
  }
  return out;
}

/** 行末の診断の文言の前に空ける文字。 */
const DIAG_LEAD = "   ● ";

/** 行末に出す診断の文言（1 行目だけ）を、room 桁に収まるだけ薄く並べる。 */
function diagMessage(d: Diagnostic, room: number): Cell[] {
  const fg = diagStyle(d.severity);
  const out: Cell[] = [];
  let v = 0;
  for (const raw of DIAG_LEAD + firstLine(d.message)) {
    const ch = raw === "\t" ? " " : raw;
    const w = runeWidth(ch, v);
    if (v + w > room) break;
    out.push({ ch, cells: w, fg, faint: true });
    v += w;
  }
  return out;
}

/** 同じ見た目で続く 1 桁の文字を 1 つの区間にまとめる（全角の文字は 1 文字ずつ別の区間のまま）。 */
function mergeRuns(cells: readonly Cell[]): Run[] {
  const out: Run[] = [];
  let narrow = false; // 最後の区間が 1 桁の文字だけでできている
  for (const c of cells) {
    const last = out.at(-1);
    if (last && narrow && c.cells === 1 && sameLook(last, c)) {
      last.text += c.ch;
      last.cells++;
      continue;
    }
    out.push(runOf(c));
    narrow = c.cells === 1;
  }
  return out;
}

/**
 * line（p.lines の 1 つ）を、p の横スクロールと幅に合わせた区間の並びにする。
 * 全角の文字は、描く側が幅をそろえられるよう 1 文字ずつ別の区間にする。
 */
export function layoutLine(line: Line, p: Pane, o: LineOptions): Run[] {
  const row = line.no;
  const textW = Math.max(0, p.viewport.cols);
  const left = Math.max(0, p.viewport.left);
  const buf = isBufferLine(line, p);
  const sels = buf ? (p.selections ?? []) : [];
  const curs = buf && o.cursor ? (p.cursors ?? []) : [];
  const isGuide = guideCol(line);
  const looks = runeLooks(line);
  // 差分の行の中の変わった部分
  const words = p.kind === "diff" ? (line.words ?? []) : [];
  const wordBg = oldSide(line, p) ? "diff.del.word.bg" : "diff.add.word.bg";
  const inWord = (col: number) =>
    words.some((w) => col >= w.start && col < w.end);
  const inSel = (col: number) => {
    if (row < 0) return false;
    const at = { line: row, col };
    return sels.some((s) => !before(at, s.start) && before(at, s.end));
  };
  const isCursor = (col: number) =>
    row >= 0 && curs.some((c) => c.line === row && c.col === col);

  const cells: Cell[] = [];
  let vis = 0;
  let drawn = 0;
  for (let col = 0; col <= looks.length && drawn < textW; col++) {
    const cursor = isCursor(col);
    const sel = inSel(col);
    const eol = col === looks.length;
    if (eol && !cursor && !sel) break;
    const look: Cell = eol ? { ch: " ", cells: 1 } : { ...looks[col]! };
    const ch = look.ch;
    const rw = eol ? 1 : runeWidth(ch, vis);
    if (!eol && inWord(col)) look.bg = wordBg;
    if (sel) look.bg = "selection";
    const d = eol ? undefined : diagAt(line, col);
    if (d) {
      look.diag = d;
      look.fg ??= d;
    }
    const guide = !eol && (ch === " " || ch === "\t") && isGuide(vis);
    if (guide) look.fg = "indent.guide";
    if (ch === "\t" || eol) {
      // 1 桁ずつ空白にする（カーソルとガイドは先頭の桁だけ）
      for (let c = 0; c < rw; c++) {
        if (vis + c >= left && drawn < textW) {
          cells.push({
            ...look,
            ch: " ",
            cells: 1,
            cursor: cursor && c === 0,
            guide: guide && c === 0,
          });
          drawn++;
        }
      }
    } else if (vis >= left) {
      if (drawn + rw > textW) break;
      cells.push({ ...look, ch: guide ? " " : ch, cells: rw, cursor, guide });
      drawn += rw;
    } else if (vis + rw > left) {
      // 全角の文字の右半分だけが見える。空白で埋める
      const n = vis + rw - left;
      for (let c = 0; c < n; c++) cells.push({ ...look, ch: " ", cells: 1 });
      drawn += n;
    }
    vis += rw;
  }

  const tailBg = inSel(looks.length) ? "selection" : undefined;
  const tail = tailGuides(line, vis, left, textW - drawn, tailBg);
  cells.push(...tail);
  drawn += tail.length;

  // TUI と同じく、6 桁より多く空いているときだけ
  const head = headDiagnostic(line.diag);
  if (head && drawn + 6 < textW)
    cells.push(...diagMessage(head, textW - drawn));

  return mergeRuns(cells);
}

/** s の 1 行目。 */
function firstLine(s: string): string {
  const i = s.search(/\r?\n/);
  return i < 0 ? s : s.slice(0, i);
}

/** 1 行の高さ（px）。files.css の --files-line-height と同じ。 */
export const LINE_HEIGHT = 22;
/** 本文の上下の余白（px）。files.css の --files-pad-y と同じ。 */
export const PAD_Y = 10;

/** 欄に入るマス目の数。 */
export interface FilesSize {
  cols: number;
  rows: number;
}

/** 本文の px の大きさ（余白を含む）から、入るマス目の桁数と行数を出す（少なくとも 1）。 */
export function cellsFor(
  width: number,
  height: number,
  cellWidth: number,
): FilesSize {
  return {
    cols: Math.max(1, Math.floor(width / Math.max(1, cellWidth))),
    rows: Math.max(1, Math.floor((height - 2 * PAD_Y) / LINE_HEIGHT)),
  };
}

/**
 * line を描くのに使うペインの項目だけを並べた文字列。これが同じなら layoutLine と lineBg の結果も同じなので、
 * 描く側はペインが新しいオブジェクトになっても（カーソルが別の行で動いたなど）、この行を描き直さずに済む。
 * line そのものは含めない（行が変われば、描く側は別の行として作り直す）。
 */
export function lineKey(line: Line, p: Pane, o: LineOptions): string {
  const row = line.no;
  const buf = isBufferLine(line, p);
  const touches = (s: Range) => s.start.line <= row && row <= s.end.line;
  return JSON.stringify([
    p.kind,
    p.diff?.side,
    p.viewport.cols,
    p.viewport.left,
    p.viewport.total,
    isCurrentLine(line, p),
    hasSelection(p.selections),
    buf && o.cursor
      ? (p.cursors ?? []).filter((c) => c.line === row).map((c) => c.col)
      : [],
    buf ? (p.selections ?? []).filter(touches) : [],
  ]);
}
