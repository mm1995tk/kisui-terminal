// サイドバーの帯とタブの行を、つかむ所（.grip）からのドラッグで上下に並べ替える（#236）。
// 動くのは上下だけ。落とし先は、押している位置（y）が、どの行の真ん中より上かで決める。
// 並びそのものは持たない（落とし先を「どの行の前か」で App に返し、App が gws/model.ts の moveBefore・moveTabBefore で動かして覚える）。
// DOM を触るのは startDrag と dropMarker だけ。落とし先を決める dropBefore と、自動のスクロールの量 edgeScroll は DOM を使わない（node --test で確かめられる）。
//
// 行の DOM は、ドラッグの途中でも作り直される（サイドバーの行は、ターミナルの題名や git の知らせで作り直される）。
// そのため、行の要素を覚えず、動くたびに items() で引き直す。動かしている行も、そのたびに印を付け直す。

/** 並びの 1 行（key は行を指すもの、mid は画面での縦の真ん中）。 */
export interface DragItem {
  key: string;
  mid: number;
}

/**
 * y に落としたとき、どの行の前に入るか（一番後ろなら null）。
 * 動かしている行（self）は数えない。items は上から順。
 */
export function dropBefore(
  items: readonly DragItem[],
  self: string,
  y: number,
): string | null {
  for (const it of items) if (it.key !== self && it.mid > y) return it.key;
  return null;
}

/** 動かしてよいほど離れたか（押しただけ・少し手が触れただけでは始めない）。 */
export const DRAG_THRESHOLD = 4;

/** 一覧の端から、この距離（px）に入ると、一覧を自動でスクロールする。 */
export const EDGE = 28;

/**
 * 押している位置 y のときの、1 フレームのスクロール量（上なら負、下なら正、端から離れていれば 0）。
 * top・bottom は一覧の上端・下端。端に近いほど速い。
 */
export function edgeScroll(y: number, top: number, bottom: number): number {
  if (y < top + EDGE) return -Math.ceil((top + EDGE - y) / 3);
  if (y > bottom - EDGE) return Math.ceil((y - (bottom - EDGE)) / 3);
  return 0;
}

/** 並びの 1 行の、いまの DOM。 */
export interface DragRow {
  key: string;
  /** 印（data-dragging・data-drop）を付ける要素 */
  el: HTMLElement;
  /** 縦の真ん中を測る要素 */
  ref: HTMLElement;
}

/** 落とし先の印。data-drop="before"（その行の上）か "after"（その行の下）を、いま 1 つの行にだけ付ける。 */
function dropMarker() {
  let marked: HTMLElement | null = null;
  return (el: HTMLElement | null, at?: "before" | "after") => {
    if (marked === el && el?.dataset.drop === at) return;
    marked?.removeAttribute("data-drop");
    marked = el;
    if (el && at) el.dataset.drop = at;
  };
}

export interface DragSpec {
  /** 一覧（スクロールする要素）。作り直されない */
  scroller: HTMLElement;
  /** 動かす行のキー */
  self: string;
  /** 並びの全部の行（動かしている行も）を、いまの DOM から引き直して返す。呼ぶたびに引き直すこと */
  rows: () => DragRow[];
  /** 落とした（before は、その行の前。一番後ろなら null）。動かさずに離したときは呼ばない */
  onDrop: (before: string | null) => void;
}

/**
 * つかむ所を押したときに呼ぶ。以降の pointermove / pointerup / Esc を受け持ち、終われば全部外す。
 */
export function startDrag(e: PointerEvent, spec: DragSpec): void {
  if (e.button !== 0) return;
  e.preventDefault(); // 文字の選択やスクロールを始めない
  const startY = e.clientY;
  let y = e.clientY;
  let active = false;
  let frame = 0;
  let before: string | null = null;
  let dragged: HTMLElement | null = null;
  const mark = dropMarker();

  // 落とし先を決めて印を付ける。動かしている行の印も、作り直されていれば付け直す
  const update = () => {
    const rows = spec.rows();
    const self = rows.find((r) => r.key === spec.self)?.el ?? null;
    if (self !== dragged) {
      dragged?.removeAttribute("data-dragging");
      dragged = self;
      dragged?.setAttribute("data-dragging", "");
    }
    before = dropBefore(
      rows.map((r) => {
        const b = r.ref.getBoundingClientRect();
        return { key: r.key, mid: b.top + b.height / 2 };
      }),
      spec.self,
      y,
    );
    if (before !== null) {
      mark(rows.find((r) => r.key === before)?.el ?? null, "before");
    } else {
      const last = rows.filter((r) => r.key !== spec.self).pop();
      mark(last?.el ?? null, "after");
    }
  };

  // 一覧の端にいるあいだは、フレームごとにスクロールする
  const tick = () => {
    frame = 0;
    if (!active) return;
    const r = spec.scroller.getBoundingClientRect();
    const dy = edgeScroll(y, r.top, r.bottom);
    if (dy === 0) return;
    spec.scroller.scrollTop += dy;
    update();
    frame = requestAnimationFrame(tick);
  };

  const move = (ev: PointerEvent) => {
    y = ev.clientY;
    if (!active) {
      if (Math.abs(y - startY) < DRAG_THRESHOLD) return;
      active = true;
      document.body.style.cursor = "grabbing";
    }
    update();
    if (frame === 0) frame = requestAnimationFrame(tick);
  };

  const finish = (drop: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    if (frame !== 0) cancelAnimationFrame(frame);
    mark(null);
    dragged?.removeAttribute("data-dragging");
    document.body.style.cursor = "";
    if (active && drop) spec.onDrop(before);
    active = false;
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(false);
  };

  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
}
