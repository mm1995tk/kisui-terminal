// ファイルの欄のポップアップ（E4）の置き場所と大きさを決める。描くのは OverlayView.tsx。
// shj が送る Screen.overlay（Go の screen.Overlay）を、欄の本文のマス目（桁と行）の上の箱にする。
// 置き方は TUI（ui/tui の app_draw.go の popupPos、signature_draw.go の signaturePos、
// spacemenu_draw.go の renderMenu、prreview_draw.go の cardBox・composerBox、palette の中央寄せ）に合わせる。
//
// - 位置（at）は「ペインの中の行と桁（rune）」で来る。行はペインの見えている行から探し、桁は
//   その行の文字の幅（全角・タブ）でマス目にする（幅の計算は描く側の仕事。設計書 1 章）。
// - 確認（confirm）は TUI と同じく状態行に出すので、箱にしない（bars.ts の statusLeft）。

import type {
  Files,
  Item,
  Line,
  Overlay,
  Pane,
  Pos,
  Span,
} from "../rpc/protocol.ts";
import { lineText, textCells } from "./bars.ts";
import {
  isDeletedLine,
  layoutLine,
  paneCells,
  paneGutter,
  type Run,
} from "./layout.ts";
import { runeWidth } from "./width.ts";

/** 欄の本文のマス目の数。 */
export interface Area {
  cols: number;
  rows: number;
}

/** 本文の上の箱（マス目）。x は本文の左端から、y は本文の 1 行目から。 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 本文のマス目 1 つ。 */
export interface Cell {
  x: number;
  y: number;
}

/** ペインの中の位置の、本文のマス目。shown は、その位置が今ペインに見えているか（行も桁も）。 */
export interface Anchor extends Cell {
  shown: boolean;
}

/** 補完の窓の幅の下限と上限（TUI の drawCompletion と同じ）。 */
const COMPLETION_MIN_W = 20;
const COMPLETION_MAX_W = 60;
/** 補完の候補の種類の欄の幅。 */
export const COMPLETION_KIND_W = 9;
/** レビューのコメントの入力欄の行数（TUI の textarea の高さと同じ）。 */
export const COMPOSE_ROWS = 6;

/** ペイン id の左端の桁（左に並ぶペインの幅と、間の 1 桁を足したもの）。無ければ undefined。 */
export function paneLeft(
  files: Files | undefined,
  id: string,
): number | undefined {
  let x = 0;
  for (const p of files?.panes ?? []) {
    if (p.id === id) return x;
    x += paneCells(p) + 1;
  }
  return undefined;
}

/** line の先頭から col 個の rune までの幅（マス目）。 */
function runesCells(line: Line, col: number): number {
  let vis = 0;
  let i = 0;
  for (const sp of line.spans ?? []) {
    for (const ch of sp.text) {
      if (i >= col) return vis;
      vis += runeWidth(ch, vis);
      i++;
    }
  }
  return vis + Math.max(0, col - i);
}

/**
 * ペイン id の中の位置 at が、本文のどのマス目に当たるか。ペインが無ければ undefined。
 * 行が見えていないときは、ビューポートの先頭からの差で数える（はみ出したまま返す）。
 * 1 列の差分のペインでは、消した行も古い側の行番号を持つので、消した行（印が deleted）は飛ばす。
 */
export function anchorCell(
  files: Files | undefined,
  id: string | undefined,
  at: Pos | undefined,
): Anchor | undefined {
  if (!id || !at) return undefined;
  const left = paneLeft(files, id);
  const p = files?.panes.find((q) => q.id === id);
  if (left === undefined || !p) return undefined;
  const lines = p.lines ?? [];
  const row = lines.findIndex((l) => l.no === at.line && !isDeletedLine(l));
  const y = row >= 0 ? row : at.line - p.viewport.top;
  const line = row >= 0 ? lines[row] : undefined;
  const vis = line ? runesCells(line, at.col) : at.col;
  const gutter = paneGutter(p);
  const rel = vis - p.viewport.left;
  const col = Math.max(0, Math.min(rel, p.viewport.cols - 1));
  const shown = row >= 0 && rel >= 0 && rel < p.viewport.cols;
  return { x: left + gutter + col, y, shown };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, Math.max(lo, hi)));
}

/** 箱を a の下の行に置く。下に入らず上に入るなら上に置く。本文からはみ出さないようにする（TUI の popupPos）。 */
export function placeBelow(a: Cell, w: number, h: number, area: Area): Box {
  const x = clamp(a.x, 0, area.cols - w);
  let y = a.y + 1;
  if (y + h > area.rows && a.y - h >= 0) y = a.y - h;
  y = Math.max(0, Math.min(y, area.rows - h));
  return { x, y, w, h };
}

/** 箱を a の上の行に置く。上に入らなければ下に置く（TUI の signaturePos）。 */
export function placeAbove(a: Cell, w: number, h: number, area: Area): Box {
  const x = clamp(a.x, 0, area.cols - w);
  let y = a.y - h;
  if (y < 0) y = a.y + 1;
  return { x, y, w, h };
}

/** 補完の窓の幅。候補の名前と種類の欄が入る幅（20〜60）。 */
export function completionWidth(items: readonly Item[]): number {
  let w = COMPLETION_MIN_W;
  for (const it of items)
    w = Math.max(w, textCells(it.label) + 1 + COMPLETION_KIND_W);
  return Math.min(w, COMPLETION_MAX_W);
}

/** メニューの並べ方。cols は列の数、per は 1 列の行数、cellW は 1 項目の幅。 */
export interface MenuLayout {
  cols: number;
  per: number;
  cellW: number;
  w: number;
}

/** メニュー（スペースキーの後など）の並べ方。項目が多く幅があれば 2 列にする（TUI の drawMenu）。 */
export function menuLayout(items: readonly Item[], maxW: number): MenuLayout {
  const cols = items.length < 6 || maxW < 60 ? 1 : 2;
  const per = Math.ceil(items.length / cols);
  let cellW = 0;
  for (const it of items) {
    cellW = Math.max(
      cellW,
      textCells(it.detail ?? "") + 1 + textCells(it.label),
    );
  }
  const w = Math.min(cols * cellW + (cols - 1) * 2 + 2, maxW);
  return { cols, per, cellW, w };
}

/** パレットの幅。欄の 3/5（30〜100、欄より広くしない）。TUI の PaletteWidth と同じ決め方。 */
export function paletteWidth(area: Area): number {
  return Math.min(area.cols, clamp(Math.floor((area.cols * 3) / 5), 30, 100));
}

/** 検索の窓の、一覧とプレビュー以外の行数（見出し、入力欄 2 段、オプション、状態、仕切り、下の余白）。 */
export const SEARCH_FIXED_ROWS = 11;

/** 検索の窓の一覧とプレビューの幅（枠の内側の桁から仕切りの 1 桁を引いて半分）。TUI の SearchGeom の Lw・Rw。 */
export function searchColumns(boxCols: number): {
  left: number;
  right: number;
} {
  const inner = Math.max(0, boxCols - 2);
  const left = Math.floor((inner - 1) / 2);
  return { left, right: inner - 1 - left };
}

/** 検索の窓の行番号の桁数（TUI の viewRows と同じく 3 桁以上）。 */
export function searchGutterCells(total: number): number {
  return Math.max(3, String(total).length);
}

/** 一覧の行の頭の印（置換から外した行は x、選んだ行は >）。 */
export function searchMarker(skip: boolean, selected: boolean): string {
  return skip ? "x " : selected ? "> " : "  ";
}

/** ホバー・レビューカードの枠の下に出す、見えている行の位置（「↑ 12/40 ↓」）。全部見えていれば空。 */
export function scrollIndicator(ov: Overlay): string {
  const v = ov.view;
  if (!v || v.total <= v.rows) return "";
  const end = v.top + (ov.lines?.length ?? 0);
  let s = `${end}/${v.total}`;
  if (v.top > 0) s = `↑ ${s}`;
  if (end < v.total) s = `${s} ↓`;
  return s;
}

/** レビューカードのうち、コメントの入力欄のもの（返信・コメントの編集）。 */
export function isComposer(ov: Overlay): boolean {
  return ov.kind === "reviewCard" && !!ov.compose;
}

/**
 * ov を本文のどこに、どの大きさで出すか。files は今のペイン、area は本文のマス目の数。
 * 箱にしないもの（確認）と、出すものが無いときは undefined。
 */
export function overlayBox(
  ov: Overlay,
  files: Files | undefined,
  area: Area,
): Box | undefined {
  const fit = (w: number) => Math.max(1, Math.min(w, area.cols));
  switch (ov.kind) {
    case "completion": {
      const n = ov.items?.length ?? 0;
      if (n === 0) return undefined;
      const a = anchorCell(files, ov.pane, ov.at) ?? { x: 0, y: 0 };
      return placeBelow(a, fit(completionWidth(ov.items!)), n, area);
    }
    case "hover": {
      // 上に「コピー」、下に案内と位置の行。左右に 1 桁ずつ空ける
      const a = anchorCell(files, ov.pane, ov.at) ?? { x: 0, y: 0 };
      return placeBelow(
        a,
        viewBoxWidth(ov, area),
        (ov.lines?.length ?? 0) + 2,
        area,
      );
    }
    case "signature": {
      // カーソルが見えていなければ出さない（TUI の cursorShown。ホイールはカーソルを動かさない）
      const a = anchorCell(files, ov.pane, ov.at);
      if (!a?.shown || a.y >= area.rows) return undefined;
      return placeAbove(
        a,
        fit(textCells(lineText(ov.lines?.[0])) + 2),
        1,
        area,
      );
    }
    case "reviewCard":
      return isComposer(ov) ? composerBox(ov, area) : cardBox(ov, files, area);
    case "menu": {
      const n = ov.items?.length ?? 0;
      if (n === 0) return undefined;
      const m = menuLayout(ov.items!, area.cols);
      const h = 1 + m.per;
      return {
        x: Math.max(0, area.cols - m.w),
        y: Math.max(0, area.rows - h),
        w: m.w,
        h,
      };
    }
    case "search": {
      // 欄いっぱい（周りに 1 マスの余白）。高さは固定の行と一覧の高さ（TUI の SearchGeom）
      if (!ov.search) return undefined;
      const w = Math.min(area.cols, Math.max(30, area.cols - 2));
      const h = Math.min(area.rows, ov.search.bodyRows + SEARCH_FIXED_ROWS);
      return {
        x: Math.floor((area.cols - w) / 2),
        y: Math.min(1, Math.max(0, area.rows - h)),
        w,
        h,
      };
    }
    case "palette": {
      const w = paletteWidth(area);
      const h = 1 + (ov.items?.length ?? 0) + (ov.hint ? 1 : 0);
      return { x: Math.max(0, Math.floor((area.cols - w) / 2)), y: 0, w, h };
    }
    default:
      return undefined;
  }
}

/** view.cols の行が入る箱の幅（ホバー・カード・コメントの入力欄）。左右に 1 桁ずつ空け、欄より広くしない。 */
function viewBoxWidth(ov: Overlay, area: Area): number {
  return Math.max(1, Math.min((ov.view?.cols ?? 1) + 2, area.cols));
}

/** レビューのスレッドのカード。スレッドの行の下に、見えていなければ左上に置く（TUI の cardBox）。 */
function cardBox(ov: Overlay, files: Files | undefined, area: Area): Box {
  const w = viewBoxWidth(ov, area);
  const h = (ov.lines?.length ?? 0) + 1;
  const a = anchorCell(files, ov.pane, ov.at && { line: ov.at.line, col: 0 });
  const seen = a && a.y >= 0 && a.y < area.rows;
  return placeBelow(seen ? a : { x: 2, y: 1 }, w, h, area);
}

/**
 * レビューのコメントの入力欄。見出し、入力欄、案内、（あれば）プレビューの見出しと行。
 * 本文の下の真ん中に置く（TUI の composerBox）。
 */
function composerBox(ov: Overlay, area: Area): Box {
  const w = viewBoxWidth(ov, area);
  const preview = ov.compose?.previewLabel ? 1 + (ov.lines?.length ?? 0) : 0;
  const h = 1 + COMPOSE_ROWS + 1 + preview;
  return {
    x: Math.max(0, Math.floor((area.cols - w) / 2)),
    y: Math.max(0, area.rows - h),
    w,
    h,
  };
}

/** ポップアップの中の 1 行を、cols 桁に入る区間の並びにする（全角とタブの幅は本文と同じ決め方）。 */
export function overlayRuns(line: Line, cols: number): Run[] {
  const pane: Pane = {
    id: "",
    title: { text: "" },
    kind: "overlay",
    viewport: { top: 0, rows: 1, cols: Math.max(0, cols), left: 0, total: 0 },
    curLine: -1,
  };
  return layoutLine({ ...line, no: -1 }, pane, { cursor: false });
}

/** 名前の区間。hi は検索に合った文字。 */
export interface LabelPart {
  text: string;
  hi: boolean;
}

/** 項目の名前を、検索に合った文字（matched）とそれ以外の区間に分ける。 */
export function labelParts(it: Item): LabelPart[] {
  const hit = new Set(it.matched ?? []);
  const out: LabelPart[] = [];
  let i = 0;
  for (const ch of it.label) {
    const hi = hit.has(i++);
    const last = out.at(-1);
    if (last && last.hi === hi) last.text += ch;
    else out.push({ text: ch, hi });
  }
  return out;
}

/** パレットの入力欄の前の見出し（TUI の PaletteLabel）。 */
export function paletteLabel(
  title: string | undefined,
  prefix: string,
): string {
  if (prefix === ":") return ` ${title ?? ""}: `;
  if (title) return ` ${title} > `;
  return " > ";
}

/** 確認（y/n の問い・もう一度押すと捨てる）。無ければ undefined。 */
export function confirmOf(
  overlays: readonly Overlay[] | null | undefined,
): Overlay | undefined {
  return overlays?.find((o) => o.kind === "confirm");
}

/**
 * コメントの入力欄の行のうち、見せる COMPOSE_ROWS 行（カーソルの行が見えるようにずらす）。
 * first は先頭の行の番号。
 */
export function composeRows(
  text: string,
  cursorLine: number,
): { first: number; rows: string[] } {
  const all = text.split("\n");
  const first = Math.max(
    0,
    Math.min(cursorLine - COMPOSE_ROWS + 1, all.length - COMPOSE_ROWS),
  );
  return { first, rows: all.slice(first, first + COMPOSE_ROWS) };
}

/** 文字の区間の並びから、ポップアップに描く 1 行を作る（overlayRuns に渡して全角の幅を本文とそろえる）。 */
export function textLine(spans: readonly Span[]): Line {
  return { no: -1, spans: spans.filter((s) => s.text !== "") };
}

/**
 * 項目（パレット）の 1 行。検索に合った文字は palette.hi の太字、補足（detail）は薄く後ろに付ける。
 * 色の無い文字は、行の色（選択中の項目なら strong）で描く。
 */
export function itemLine(it: Item): Line {
  const spans: Span[] = labelParts(it).map((p) =>
    p.hi ? { text: p.text, style: "palette.hi", bold: true } : { text: p.text },
  );
  if (it.detail && it.detail !== ".")
    spans.push({ text: `  ${it.detail}`, style: "lineno" });
  return textLine(spans);
}
