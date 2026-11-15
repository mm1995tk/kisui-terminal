// サイドバーの帯とタブの行を、つかむ所（.grip）からのドラッグで上下に並べ替える（#236）。
// 動くのは上下だけ。落とし先は、押している位置（y）が、どの行の真ん中より上かで決める。
// 並びそのものは持たない（落とし先を「どの行の前か」で App に返し、App が gws/model.ts の moveBefore・moveTabBefore で動かして覚える）。
// DOM を触るのは startDrag だけ。落とし先を決める dropBefore は DOM を使わない（node --test で確かめられる）。

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
const EDGE = 28;

export interface DragSpec {
  /** 一覧（スクロールする要素） */
  scroller: HTMLElement;
  /** 動かす行のキー */
  self: string;
  /** 並びの行。いま、そのときの画面の位置で（スクロールで動くので、そのたびに呼ぶ） */
  items: () => { key: string; el: HTMLElement; ref: HTMLElement }[];
  /** 動かしている行 */
  source: HTMLElement;
  /** 落とした（before は、その行の前。一番後ろなら null）。動かさずに離したときは呼ばない */
  onDrop: (before: string | null) => void;
}

/**
 * つかむ所を押したときに呼ぶ。以降の pointermove / pointerup / Esc を受け持ち、終われば全部外す。
 * 落とし先の印は、行に data-drop="before"（その行の上）か "after"（一番後ろに落とすとき、一番後ろの行の下）を付けて出す。
 */
export function startDrag(e: PointerEvent, spec: DragSpec): void {
  if (e.button !== 0) return;
  e.preventDefault(); // 文字の選択やスクロールを始めない
  const startY = e.clientY;
  let y = e.clientY;
  let active = false;
  let frame = 0;
  let marked: HTMLElement | null = null;
  let before: string | null = null;

  const mark = (el: HTMLElement | null, at?: "before" | "after") => {
    if (marked === el && el?.dataset.drop === at) return;
    marked?.removeAttribute("data-drop");
    marked = el;
    if (el && at) el.dataset.drop = at;
  };

  const update = () => {
    const items = spec.items();
    const mids = items.map((it) => {
      const r = it.ref.getBoundingClientRect();
      return { key: it.key, mid: r.top + r.height / 2 };
    });
    before = dropBefore(mids, spec.self, y);
    if (before !== null) {
      mark(items.find((it) => it.key === before)?.el ?? null, "before");
    } else {
      const last = [...items].reverse().find((it) => it.key !== spec.self);
      mark(last?.el ?? null, "after");
    }
  };

  // 一覧の端にいるあいだは、フレームごとにスクロールする
  const tick = () => {
    frame = 0;
    if (!active) return;
    const r = spec.scroller.getBoundingClientRect();
    const dy =
      y < r.top + EDGE
        ? -Math.ceil((r.top + EDGE - y) / 3)
        : y > r.bottom - EDGE
          ? Math.ceil((y - (r.bottom - EDGE)) / 3)
          : 0;
    if (dy !== 0) {
      spec.scroller.scrollTop += dy;
      update();
      frame = requestAnimationFrame(tick);
    }
  };

  const move = (ev: PointerEvent) => {
    y = ev.clientY;
    if (!active) {
      if (Math.abs(y - startY) < DRAG_THRESHOLD) return;
      active = true;
      spec.source.dataset.dragging = "";
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
    spec.source.removeAttribute("data-dragging");
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
