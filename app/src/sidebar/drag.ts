// サイドバーの帯とタブの行を、つかむ所（.grip）からのドラッグで上下に並べ替える（#236, #259）。
// 動くのは上下だけ。つかんだ行はマウスについて動き、ほかの行は入る場所を空けるようによける（どちらも transform。よける動きの速さは CSS の transition）。
// 落とし先は、つかんだ行の真ん中が、どの行の真ん中より上かで決める。
// 並びそのものは持たない（落とし先を「どの行の前か」で App に返し、App が gws/model.ts の moveBefore・moveTabBefore で動かして覚える）。
// DOM を触るのは startDrag だけ。落とし先を決める dropBefore、よける量を決める layoutShifts と、自動のスクロールの量 edgeScroll は DOM を使わない（node --test で確かめられる）。
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

/** 並びの 1 行の、動かす前の縦の位置（top は画面での上端、height は高さ）。 */
export interface DragSlot {
  key: string;
  top: number;
  height: number;
}

/**
 * つかんだ行（self）が before の行の前に入るとき、ほかの行がよける量（px。下へなら正）。
 * items は動かす前の位置で、上から順（self も含む）。つかんだ行が抜けた空きと、入る空きの間にある行だけが、1 行分（行間も）動く。
 */
export function layoutShifts(
  items: readonly DragSlot[],
  self: string,
  before: string | null,
): Map<string, number> {
  const out = new Map<string, number>();
  const i = items.findIndex((it) => it.key === self);
  if (i < 0) return out;
  const s = items[i]!;
  const others = items.filter((it) => it.key !== self);
  if (others.length === 0) return out;
  // 1 行分の幅：次の行の上端までの距離。一番後ろなら、行の高さに前の行との間を足す
  const next = items[i + 1];
  const prev = items[i - 1];
  const slot = next
    ? next.top - s.top
    : s.height + (s.top - (prev!.top + prev!.height));
  const found =
    before === null ? -1 : others.findIndex((o) => o.key === before);
  const j = found < 0 ? others.length : found;
  others.forEach((o, k) => {
    let d = 0;
    if (k < i && k >= j) d = slot;
    else if (k >= i && k < j) d = -slot;
    out.set(o.key, d);
  });
  return out;
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
  /** 動かす要素（transform を掛ける。つかんだ行に data-dragging、よける行に data-shift を付ける） */
  el: HTMLElement;
  /** 落とし先を決めるために、縦の真ん中を測る要素（el の中） */
  ref: HTMLElement;
}

/** el にいま掛かっている縦の移動量（px）。transition の途中なら、途中の値。 */
function currentShift(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  return t && t !== "none" ? new DOMMatrixReadOnly(t).m42 : 0;
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
  let grabOffset: number | null = null; // つかんだ行の上端から、押した位置までの距離
  let marked: HTMLElement[] = [];

  const clear = (el: HTMLElement) => {
    el.removeAttribute("data-dragging");
    el.removeAttribute("data-shift");
    el.style.transform = "";
  };

  // 行を動かす。行は作り直されることがあるので、毎回いまの DOM から引き直して掛け直す
  const update = () => {
    const rows = spec.rows();
    // 動く前の（transform を除いた）位置。transition の途中でも、いまの移動量を引けば元の位置が分かる
    const natural = rows.map((r) => {
      const shift = currentShift(r.el);
      const b = r.el.getBoundingClientRect();
      const m = r.ref.getBoundingClientRect();
      return {
        key: r.key,
        el: r.el,
        top: b.top - shift,
        height: b.height,
        mid: m.top - shift + m.height / 2,
      };
    });
    const self = natural.find((n) => n.key === spec.self);
    if (!self) return;
    grabOffset ??= startY - self.top;
    const selfShift = y - grabOffset - self.top;
    before = dropBefore(natural, spec.self, self.mid + selfShift);
    const shifts = layoutShifts(natural, spec.self, before);
    for (const n of natural) {
      if (n.key === spec.self) {
        n.el.setAttribute("data-dragging", "");
        n.el.removeAttribute("data-shift");
        n.el.style.transform = `translateY(${selfShift}px)`;
      } else {
        n.el.removeAttribute("data-dragging");
        n.el.setAttribute("data-shift", "");
        n.el.style.transform = `translateY(${shifts.get(n.key) ?? 0}px)`;
      }
    }
    const now = natural.map((n) => n.el);
    for (const el of marked) if (!now.includes(el)) clear(el);
    marked = now;
  };

  // 行が作り直されたら（題名や git の知らせ）、新しい行にも掛け直す
  const observer = new MutationObserver(() => {
    if (active) update();
  });
  observer.observe(spec.scroller, { childList: true, subtree: true });

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
    const wasActive = active;
    active = false;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    if (frame !== 0) cancelAnimationFrame(frame);
    observer.disconnect();
    for (const el of marked) clear(el);
    for (const r of spec.rows()) clear(r.el);
    document.body.style.cursor = "";
    if (wasActive && drop) spec.onDrop(before);
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
