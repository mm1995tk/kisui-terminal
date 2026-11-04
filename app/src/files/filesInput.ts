// ファイルの欄の入力（E2）を DOM のイベントから受け、shj に送る。FilesView は、ここが返すハンドラを要素につなぐだけ。
// パラメータの作り方は input.ts、OS のクリップボードは clipboard.ts。
//
// - createOrderedSend：送る順番を守る（クリップボードを読み終えるまで、後の入力を待たせる）。
// - createKeyInput：キー・IME・貼り付け（見えない textarea で受ける）。
// - createPointerInput：マウスのボタン・ドラッグ・ホイール。

import { onCleanup } from "solid-js";

import type { Files, Requests } from "../rpc/protocol.ts";
import type { InputMethod } from "../ssh/session.ts";
import type { OsClipboard } from "./clipboard.ts";
import {
  cellAt,
  ClickCounter,
  commitParams,
  isPasteKey,
  keyParams,
  modsOf,
  runeOffset,
  WheelAccumulator,
} from "./input.ts";
import { LINE_HEIGHT, paneGutter } from "./layout.ts";

/** 入力を shj に送る（seq は送る側が付ける）。 */
export type SendInput = <M extends InputMethod>(
  method: M,
  params: Omit<Requests[M]["params"], "seq">,
) => void;

/** 入力の領域。今はファイルの欄だけ。 */
const REGION = "files";

/** 順番を守って送るもの（createOrderedSend が返す）。 */
export interface OrderedSend {
  /** 待っているものが無ければすぐ送り、あればその後ろに並べる。 */
  send: SendInput;
  /** p が終わってから f を呼ぶ。その間に send したものは f の後に送る。p が失敗したら f は呼ばない。 */
  after<T>(p: Promise<T>, f: (v: T) => void): void;
}

/** raw() に送る、順番を守る送り口を作る。raw() が undefined なら捨てる。 */
export function createOrderedSend(
  raw: () => SendInput | undefined,
): OrderedSend {
  let tail: Promise<void> | null = null;
  /** after の f を呼んでいる最中（f の中の send は、並べずにその場で送る） */
  let inside = false;
  const track = (p: Promise<unknown>) => {
    const t: Promise<void> = p
      .then(
        () => {},
        () => {},
      )
      .then(() => {
        if (tail === t) tail = null;
      });
    tail = t;
  };
  const run = (fn: () => unknown) => {
    if (tail === null || inside) {
      const r = fn();
      if (r instanceof Promise) track(r);
    } else {
      track(tail.then(fn));
    }
  };
  return {
    send: (method, params) => run(() => raw()?.(method, params)),
    after: (p, f) =>
      run(() =>
        p.then((v) => {
          inside = true;
          try {
            f(v);
          } finally {
            inside = false;
          }
        }),
      ),
  };
}

/** createKeyInput が返す、textarea につなぐハンドラ。 */
export interface KeyInput {
  onKeyDown(e: KeyboardEvent): void;
  onPaste(e: ClipboardEvent): void;
  onCompositionStart(): void;
  onCompositionEnd(e: CompositionEvent): void;
  onInput(e: InputEvent): void;
  onFocus(): void;
}

/**
 * キー・IME・貼り付けを受ける（Solid のプリミティブ。コンポーネントの中で呼ぶ）。
 * ime はキーを受ける見えない textarea、body はそれを置く欄（IME の候補の窓をカーソルの近くに出すため）。
 * ウィンドウがフォーカスを失ったら、OS のクリップボードに書けていない文字を捨てる（ほかでコピーされうるので）。
 */
export function createKeyInput(o: {
  send: OrderedSend;
  clipboard: () => OsClipboard | undefined;
  mac: boolean;
  ime: () => HTMLTextAreaElement | undefined;
  body: () => HTMLElement | undefined;
}): KeyInput {
  const { send } = o;
  let composing = false;

  const onBlur = () => o.clipboard()?.discard();
  window.addEventListener("blur", onBlur);
  onCleanup(() => window.removeEventListener("blur", onBlur));

  /**
   * IME の候補の窓がカーソルの近くに出るよう、textarea をカーソルのマス目に置く。
   * コマンド行（E3）が開いていれば、そのカーソルの桁に置く。コマンド行は本文の外（下）にあるので、
   * 高さは本文の最後の行に収める（本文の外に出すと、変換中に WebKit がキャレットを見せようとして
   * overflow: hidden の本文をスクロールさせ、行が上にずれたまま残るため）。候補の窓はコマンド行のすぐ上に出る。
   * 入力欄のあるポップアップ（パレット・レビューのコメント。E4）が出ていれば、その入力欄のカーソルに置く。
   */
  function placeIme() {
    const ime = o.ime();
    const body = o.body();
    if (!ime || !body) return;
    const cur =
      body.parentElement?.querySelector<HTMLElement>(".files-cmdline-cursor") ??
      body.querySelector<HTMLElement>(".files-overlay [data-cursor]") ??
      body.querySelector<HTMLElement>(".files-pane[data-active] [data-cursor]");
    if (!cur) return;
    const b = body.getBoundingClientRect();
    const c = cur.getBoundingClientRect();
    const left = Math.min(c.left - b.left, body.clientWidth - c.width);
    ime.style.left = `${Math.max(0, left)}px`;
    const top = Math.min(c.top - b.top, body.clientHeight - LINE_HEIGHT);
    ime.style.top = `${Math.max(0, top)}px`;
    body.scrollTop = 0;
  }

  function sendComposition() {
    const ime = o.ime();
    if (!ime) return;
    const v = ime.value;
    send.send("input.composition", {
      region: REGION,
      text: v,
      cursor: [
        runeOffset(v, ime.selectionStart ?? v.length),
        runeOffset(v, ime.selectionEnd ?? v.length),
      ],
    });
  }

  return {
    onKeyDown(e) {
      void o.clipboard()?.flush();
      if (composing || e.isComposing || e.keyCode === 229) return;
      if (isPasteKey(e, o.mac)) {
        // macOS は OS の貼り付け（paste のイベント）に任せる。ほかは読んで送る（読み終えるまで後の入力を待たせる）
        if (o.mac) return;
        e.preventDefault();
        const cb = o.clipboard();
        if (!cb) return;
        send.after(cb.read(), (text) => {
          if (text) send.send("input.paste", { region: REGION, text });
        });
        return;
      }
      const p = keyParams(e, o.mac);
      if (!p) return;
      // Tab でフォーカスが移ったり、文字が textarea に入ったりしないように
      e.preventDefault();
      send.send("input.key", { region: REGION, ...p });
    },

    onPaste(e) {
      e.preventDefault();
      // OS のクリップボードに書けていない、shj でコピーした文字のほうが新しい
      const text =
        o.clipboard()?.unwritten ?? e.clipboardData?.getData("text/plain");
      if (text) send.send("input.paste", { region: REGION, text });
    },

    onCompositionStart() {
      composing = true;
      placeIme();
    },

    onCompositionEnd(e) {
      composing = false;
      const ime = o.ime();
      const text = e.data ?? ime?.value ?? "";
      send.send("input.composition", {
        region: REGION,
        text: "",
        cursor: null,
      });
      if (text)
        send.send("input.key", { region: REGION, ...commitParams(text) });
      if (ime) ime.value = "";
    },

    onInput(e) {
      if (composing || e.isComposing) {
        sendComposition();
        return;
      }
      const ime = o.ime();
      const text = ime?.value ?? "";
      if (ime) ime.value = "";
      // WebKit は compositionend のあとに確定の input を出すことがある（compositionend で送り済み）
      if (e.inputType?.includes("Composition")) return;
      // 変換を経ずに入った文字（キーで送らなかったもの）は、確定した文字として送る
      if (text)
        send.send("input.key", { region: REGION, ...commitParams(text) });
    },

    onFocus() {
      placeIme();
      send.send("input.focus", { region: REGION });
    },
  };
}

/** createPointerInput が返すハンドラ。 */
export interface PointerInput {
  /** 欄の mousedown */
  onMouseDown(e: MouseEvent): void;
  /** 欄の wheel（passive にせずにつなぐ） */
  onWheel(e: WheelEvent): void;
}

/** MouseEvent.button を MouseEvent.buttons のビットにする。 */
function buttonBit(button: number): number {
  return button === 1 ? 4 : button === 2 ? 2 : 1 << button;
}

/**
 * マウスのボタン・ドラッグ・ホイールを受ける（Solid のプリミティブ。コンポーネントの中で呼ぶ）。
 * files は今のペイン、cellWidth はマス目の幅（px）、focus はキーを受ける textarea にフォーカスを移す。
 * 離したのを取りこぼしたら（ウィンドウの外で離した、ほかのアプリに移った）、気づいたところで up を送って終える。
 */
export function createPointerInput(o: {
  send: OrderedSend;
  clipboard: () => OsClipboard | undefined;
  files: () => Files | undefined;
  cellWidth: () => number;
  focus: () => void;
}): PointerInput {
  const { send } = o;
  const clicks = new ClickCounter();
  const wheel = new WheelAccumulator();
  /** 押したままのボタンと、押したペイン（外へ出ても、そのペインのマス目で送る） */
  let drag:
    { el: HTMLElement; button: number; row: number; col: number } | undefined;

  /** 点（画面の px）の、ペイン el の中でのマス目。はみ出しはそのまま（上は負、core がスクロールする）。 */
  function hit(
    el: HTMLElement,
    x: number,
    y: number,
  ): { pane: string; row: number; col: number } | null {
    const id = el.dataset.paneId;
    const p = o.files()?.panes.find((q) => q.id === id);
    if (!id || !p) return null;
    const r = el.getBoundingClientRect();
    const gutter = paneGutter(p);
    return {
      pane: id,
      ...cellAt(x - r.left, y - r.top, o.cellWidth(), LINE_HEIGHT, gutter),
    };
  }

  function paneAt(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element
      ? target.closest<HTMLElement>(".files-pane")
      : null;
  }

  /** ドラッグを終えて up を送る。e が無ければ、最後に送ったマス目で送る。 */
  function finish(e?: MouseEvent) {
    const d = drag;
    if (!d) return;
    endDrag();
    const h = e ? hit(d.el, e.clientX, e.clientY) : null;
    send.send("input.mouse", {
      region: REGION,
      pane: h?.pane ?? d.el.dataset.paneId,
      kind: "up",
      button: d.button,
      row: h?.row ?? d.row,
      col: h?.col ?? d.col,
      mods: e ? modsOf(e) : [],
    });
  }

  function onDragMove(e: MouseEvent) {
    if (!drag) return;
    if ((e.buttons & buttonBit(drag.button)) === 0) {
      finish(e); // 離したのを取りこぼした
      return;
    }
    const h = hit(drag.el, e.clientX, e.clientY);
    if (!h || (h.row === drag.row && h.col === drag.col)) return;
    drag.row = h.row;
    drag.col = h.col;
    send.send("input.mouse", {
      region: REGION,
      pane: h.pane,
      kind: "move",
      button: drag.button,
      row: h.row,
      col: h.col,
      mods: modsOf(e),
    });
  }

  function onDragUp(e: MouseEvent) {
    if (drag && e.button === drag.button) finish(e);
  }

  const onBlur = () => finish();

  function endDrag() {
    drag = undefined;
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragUp);
    window.removeEventListener("blur", onBlur);
  }
  onCleanup(endDrag);

  return {
    onMouseDown(e) {
      void o.clipboard()?.flush();
      // 文字の選択を始めず、キーは textarea に残す
      e.preventDefault();
      o.focus();
      const el = paneAt(e.target);
      if (!el) return;
      if (drag) finish(); // 前の up を取りこぼしていた
      const h = hit(el, e.clientX, e.clientY);
      if (!h) return;
      // 押したところはペインの中なので、はみ出さない（行番号の欄の上は、core が桁 0 にする）
      send.send("input.mouse", {
        region: REGION,
        pane: h.pane,
        kind: "down",
        button: e.button,
        clicks: clicks.press(e.timeStamp, e.button, h.pane, h.row, h.col),
        row: h.row,
        col: h.col,
        mods: modsOf(e),
      });
      drag = { el, button: e.button, row: h.row, col: h.col };
      window.addEventListener("mousemove", onDragMove);
      window.addEventListener("mouseup", onDragUp);
      window.addEventListener("blur", onBlur);
    },

    onWheel(e) {
      e.preventDefault();
      const el = paneAt(e.target);
      const h = el && hit(el, e.clientX, e.clientY);
      if (!h) return;
      const p = o.files()?.panes.find((q) => q.id === h.pane);
      const d = wheel.add(e.deltaX, e.deltaY, e.deltaMode, {
        cellWidth: o.cellWidth(),
        lineHeight: LINE_HEIGHT,
        rows: p?.viewport.rows ?? 1,
        cols: p?.viewport.cols ?? 1,
      });
      if (d.dx === 0 && d.dy === 0) return;
      send.send("input.mouse", {
        region: REGION,
        pane: h.pane,
        kind: "wheel",
        row: h.row,
        col: h.col,
        dx: d.dx,
        dy: d.dy,
        mods: modsOf(e),
      });
    },
  };
}
