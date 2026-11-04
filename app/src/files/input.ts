// ファイルの欄の入力（E2）を、shj の input.* のパラメータにする。DOM には触らない（テストできるように）。
// 送り方は設計書 docs/design/gui-protocol.md の 3 章「キー・マウス・貼り付けの入力」。
//
// - キーは KeyboardEvent.key の名前と修飾キーをそのまま送る。Helix のキーはここで解釈しない（core がする）。
//   GUI 自身が受けるキー（isGuiKey）と、修飾キーだけ・dead key・IME の変換中のキーは送らない。
// - マウスはペインの中のマス目（row・col）にする。col は行番号の欄の右から数える。
// - ダブルクリックなどの回数（clicks）は ClickCounter が数える。
// - ホイールの px は WheelAccumulator が行と桁にする（端数は次に持ち越す）。

import type { InputKeyParams, Mod } from "../rpc/protocol.ts";

/** KeyboardEvent のうち、ここで使う項目。 */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** MouseEvent などの修飾キー。 */
export interface ModsLike {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** 押している修飾キー（Meta / Command は super）。 */
export function modsOf(e: ModsLike): Mod[] {
  const m: Mod[] = [];
  if (e.ctrlKey) m.push("ctrl");
  if (e.shiftKey) m.push("shift");
  if (e.altKey) m.push("alt");
  if (e.metaKey) m.push("super");
  return m;
}

/** 修飾キーそのもの（単独では送らない）。 */
const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "OS",
  "Super",
  "Hyper",
  "Fn",
  "FnLock",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Symbol",
  "SymbolLock",
]);

/** 動いている OS が macOS か（貼り付けのキーが違う）。 */
export function isMac(platform: string): boolean {
  return /mac|iphone|ipad/i.test(platform);
}

/**
 * OS のクリップボードから貼り付けるキー。macOS は Cmd+V、ほかはターミナルと同じ Ctrl+Shift+V。
 * （Ctrl+V は shj の中のレジスタから貼る Helix のキーなので、shj に送る）
 */
export function isPasteKey(e: KeyLike, mac: boolean): boolean {
  if (e.key.toLowerCase() !== "v" || e.altKey) return false;
  return mac
    ? e.metaKey && !e.ctrlKey && !e.shiftKey
    : e.ctrlKey && e.shiftKey && !e.metaKey;
}

/**
 * GUI 自身が受けるキー（shj に送らない）。貼り付けのキーと、ターミナルの Ctrl+Shift+T・Ctrl+Shift+`
 * （ターミナルを新しく作る、IDE モードとターミナルモードの切り替え。設計書 3 章と 6 章の F3・F4）。
 */
export function isGuiKey(e: KeyLike, mac: boolean): boolean {
  if (isPasteKey(e, mac)) return true;
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return false;
  const k = e.key.toLowerCase();
  return k === "t" || e.code === "Backquote" || k === "`" || k === "~";
}

/** 1 つの code point だけでできた名前か（"a"・"あ"・" "。"Enter" などの名前は違う）。 */
function isChar(key: string): boolean {
  return [...key].length === 1;
}

/**
 * keydown（release なら keyup）を input.key のパラメータにする（seq と region は呼ぶ側が付ける）。
 * 送らないキー（修飾キーだけ・dead key・IME の変換中・GUI が受けるキー）は null。
 */
export function keyParams(
  e: KeyLike,
  mac: boolean,
  phase: "press" | "release" = "press",
): Omit<InputKeyParams, "seq" | "region"> | null {
  // 変換中のキー（229 は IME が受けたキー。確定は compositionend から送る）
  if (e.isComposing || e.keyCode === 229 || e.key === "Process") return null;
  if (e.key === "Dead" || e.key === "Unidentified" || e.key === "") return null;
  if (MODIFIER_KEYS.has(e.key)) return null;
  if (isGuiKey(e, mac)) return null;
  let mods = modsOf(e);
  // macOS の Option で打つ文字（ドイツ語配列の Option+L = "@" など）は、Alt ではなく文字として送る
  // （macOS のターミナルの既定と同じ。Option を Meta にしない）
  if (mac && e.altKey && !e.ctrlKey && !e.metaKey && isChar(e.key))
    mods = mods.filter((m) => m !== "alt");
  const p: Omit<InputKeyParams, "seq" | "region"> = {
    key: e.key,
    mods,
    phase: phase === "release" ? "release" : e.repeat ? "repeat" : "press",
  };
  if (isChar(e.key)) p.text = e.key;
  return p;
}

/** IME で確定した文字を送る input.key（key が名前でも 1 文字でもないので、core は text を打つ）。 */
export function commitParams(
  text: string,
): Omit<InputKeyParams, "seq" | "region"> {
  return { key: "Process", mods: [], text, phase: "press" };
}

/** s の先頭から UTF-16 の位置 i までにある code point の数（input.composition の cursor は rune の位置）。 */
export function runeOffset(s: string, i: number): number {
  return [...s.slice(0, Math.max(0, i))].length;
}

/**
 * ペインの中の点（px。ペインの左上から）をマス目にする。gutter は行番号の欄の幅（マス目）。
 * はみ出したところは丸めない（上は負の行、行番号の欄の上は負の桁）。core はドラッグで上や下に
 * はみ出したらスクロールし、負の桁は 0 にする。
 */
export function cellAt(
  x: number,
  y: number,
  cellWidth: number,
  lineHeight: number,
  gutter: number,
): { row: number; col: number } {
  const row = Math.floor(y / Math.max(1, lineHeight));
  const col = Math.floor(x / Math.max(0.1, cellWidth)) - gutter;
  return { row, col };
}

/** ダブルクリック・トリプルクリックとみなす間隔（ms）。 */
export const MULTI_CLICK_MS = 400;

/** 押した回数を数える。同じボタンで、同じマス目を、間を空けずに押したら増える（3 回まで、その後は 1 に戻る）。 */
export class ClickCounter {
  private last?: {
    at: number;
    button: number;
    pane: string;
    row: number;
    col: number;
    clicks: number;
  };

  private readonly intervalMs: number;

  constructor(intervalMs = MULTI_CLICK_MS) {
    this.intervalMs = intervalMs;
  }

  /**
   * 押した。at は押した時刻（ms）、button は MouseEvent.button、pane・row・col は押したペインとマス目。
   * 戻り値は input.mouse の clicks（1 が 1 回、2 がダブルクリック、3 がトリプルクリック）。
   */
  press(
    at: number,
    button: number,
    pane: string,
    row: number,
    col: number,
  ): number {
    const l = this.last;
    const again =
      l !== undefined &&
      at - l.at <= this.intervalMs &&
      l.button === button &&
      l.pane === pane &&
      l.row === row &&
      l.col === col &&
      l.clicks < 3;
    const clicks = again ? l.clicks + 1 : 1;
    this.last = { at, button, pane, row, col, clicks };
    return clicks;
  }
}

/** WheelEvent.deltaMode：量の単位が px。 */
export const DOM_DELTA_PIXEL = 0;
/** WheelEvent.deltaMode：量の単位が行（横は桁）。 */
export const DOM_DELTA_LINE = 1;
/** WheelEvent.deltaMode：量の単位がページ。 */
export const DOM_DELTA_PAGE = 2;

/** ホイールの量を行（dy）と桁（dx）にする。1 行・1 桁に満たない分は次に持ち越す。 */
export class WheelAccumulator {
  private x = 0;
  private y = 0;

  /**
   * deltaX・deltaY（deltaMode の単位）を足し、送る行と桁を返す。どちらも 0 なら送らない。
   * page は 1 ページを rows 行・cols 桁とみなす。
   */
  add(
    dx: number,
    dy: number,
    mode: number,
    size: { cellWidth: number; lineHeight: number; rows: number; cols: number },
  ): { dx: number; dy: number } {
    if (mode === DOM_DELTA_LINE) {
      this.x += dx;
      this.y += dy;
    } else if (mode === DOM_DELTA_PAGE) {
      this.x += dx * size.cols;
      this.y += dy * size.rows;
    } else {
      this.x += dx / Math.max(0.1, size.cellWidth);
      this.y += dy / Math.max(1, size.lineHeight);
    }
    const ox = Math.trunc(this.x);
    const oy = Math.trunc(this.y);
    this.x -= ox;
    this.y -= oy;
    return { dx: ox, dy: oy };
  }

  /** 持ち越している端数を捨てる（向きや場所が変わって、前の端数を使いたくないとき）。 */
  reset(): void {
    this.x = 0;
    this.y = 0;
  }
}
