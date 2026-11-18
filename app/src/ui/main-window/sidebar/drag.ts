// サイドバーの帯とタブの行を、つかむ所（.grip）からのドラッグで上下に並べ替える（#236, #259）。
// 動くのは上下だけ。つかんだ行はマウスについて動き、ほかの行は入る場所を空けるようによける（どちらも transform。よける動きの速さは CSS の transition）。
// 落とし先は、つかんだ行の端が、隣の行の 4 分の 1 を越えたかで決める（下へなら下端、上へなら上端。越えたら、その行はよける）。
// つかんだ行は不透明で、手を離すと落ちる先までなめらかに動いてから並べ替える（#311）。落ちる先には、薄い枠を出す。
// 並びそのものは持たない（落とし先を「どの行の前か」で呼ぶ側に返し、features/workspaces/ の controller が model.ts の moveBefore・moveTabBefore で動かして覚える）。
// DOM を触るのは startDrag だけ。落とし先を決める dropBefore、よける量を決める layoutShifts と、自動のスクロールの量 edgeScroll は DOM を使わない（node --test で確かめられる）。
//
// 行の DOM は、ドラッグの途中でも作り直される（サイドバーの行は、ターミナルの題名や git の知らせで作り直される）。
// そのため、行の要素を覚えず、動くたびに items() で引き直す。動かしている行も、そのたびに印を付け直す。

import { isComposingKey } from "../../../features/commands/ime.ts";

/** 並びの 1 行（key は行を指すもの、mid は画面での縦の真ん中、span は真ん中を測った要素の高さ）。 */
export interface DragItem {
  key: string;
  mid: number;
  span: number;
}

/** つかんだ行の端が、隣の行のこの割合に入ったら、その行はよける。 */
export const DODGE_FRACTION = 0.25;

/**
 * y に落としたとき、どの行の前に入るか（一番後ろなら null）。
 * 動かしている行（self）は数えない。items は上から順。
 * y は、下へ動かしているとき（down）はつかんだ行の下端、上へなら上端。隣の行の端から DODGE_FRACTION だけ入ったところで、その行を越えたことにする。
 */
export function dropBefore(
  items: readonly DragItem[],
  self: string,
  y: number,
  down = false,
): string | null {
  for (const it of items) {
    if (it.key === self) continue;
    const quarter = it.span * DODGE_FRACTION;
    // 下へは行の上端から 4 分の 1、上へは行の下端から 4 分の 1 の位置
    const trigger = down
      ? it.mid - it.span / 2 + quarter
      : it.mid + it.span / 2 - quarter;
    if (trigger > y) return it.key;
  }
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

/** つかんだ行の、動かした量と、落とし先を決める位置。 */
export interface DragPosition {
  /** つかんだ行の移動量（px。下へなら正） */
  shift: number;
  /** この位置を、ほかの行の端と比べて落とし先を決める */
  probe: number;
  /** 下へ動かしているか（probe がつかんだ行の下端か、上端か） */
  down: boolean;
}

/**
 * つかんだ行（self）を want（px）動かしたいときの、実際の移動量と落とし先を決める位置。
 * 下へ動かすときは、つかんだ行の下端を、上へ動かすときは上端を、ほかの行と比べる（背の高い行でも、空く場所とつかんだ行の位置が合う。上下とも、隣の行の 4 分の 1 に入るとよける。confine で端に止めたときも、端の行の前後に入れる）。
 * confine なら、全部の行の上端から下端までの内に収める（タブの行が、帯の外で切れて見えなくならないように）。
 */
export function dragPosition(
  items: readonly DragSlot[],
  self: string,
  want: number,
  confine: boolean,
): DragPosition | null {
  const s = items.find((it) => it.key === self);
  if (!s) return null;
  let shift = want;
  if (confine) {
    const first = items[0]!;
    const last = items[items.length - 1]!;
    shift = Math.min(
      Math.max(shift, first.top - s.top),
      last.top + last.height - (s.top + s.height),
    );
  }
  return {
    shift,
    probe: shift > 0 ? s.top + shift + s.height : s.top + shift,
    down: shift > 0,
  };
}

/**
 * つかんだ行が、落ちる先に収まったときの上端（画面での位置）。items は動かす前の位置で上から順（self も含む）、shifts は layoutShifts の結果。
 * before の行が空けた場所に入る。一番後ろなら、いちばん後ろの行の下に、行間をあけて入る。
 */
export function dropTop(
  items: readonly DragSlot[],
  self: string,
  before: string | null,
  shifts: ReadonlyMap<string, number>,
): number {
  const i = items.findIndex((it) => it.key === self);
  const s = items[i]!;
  const next = items[i + 1];
  const prev = items[i - 1];
  const slot = next
    ? next.top - s.top
    : prev
      ? s.height + (s.top - (prev.top + prev.height))
      : s.height;
  const b = before === null ? undefined : items.find((it) => it.key === before);
  if (b && b.key !== self) return b.top + (shifts.get(b.key) ?? 0) - slot;
  const last = items.filter((it) => it.key !== self).at(-1);
  if (!last) return s.top;
  return (
    last.top + (shifts.get(last.key) ?? 0) + last.height + (slot - s.height)
  );
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

/** 行の、動く前の（transform を除いた）位置。transition の途中でも、いまの移動量を引けば元の位置が分かる。 */
function measureRows(rows: readonly DragRow[]) {
  return rows.map((r) => {
    const shift = currentShift(r.el);
    const b = r.el.getBoundingClientRect();
    const m = r.ref.getBoundingClientRect();
    return {
      key: r.key,
      el: r.el,
      top: b.top - shift,
      height: b.height,
      mid: m.top - shift + m.height / 2,
      span: m.height,
    };
  });
}

/** el の transform と印を外す。 */
function clearRow(el: HTMLElement) {
  el.removeAttribute("data-dragging");
  el.removeAttribute("data-shift");
  el.removeAttribute("data-dropping");
  el.style.transform = "";
}

/** 落ちる先の枠。画面に固定して重ね（行の DOM を増やすと作り直しの見張りが反応する）、ポインタは通す。 */
function makeSlotMarker(): HTMLElement {
  const m = document.createElement("div");
  m.className = "drag-drop-slot";
  m.setAttribute("aria-hidden", "true");
  document.body.appendChild(m);
  return m;
}

/** 手を離したとき、つかんだ行が落ちる先まで動くのにかける時間（ms）。CSS の transition（data-dropping）と合わせる。 */
export const DROP_MS = 150;

/** つかんだ行に selfShift、ほかの行に shifts の量の transform と印を掛ける。掛けた要素を返す。 */
function applyDrag(
  measured: readonly { key: string; el: HTMLElement }[],
  self: string,
  selfShift: number,
  shifts: ReadonlyMap<string, number>,
): HTMLElement[] {
  for (const n of measured) {
    if (n.key === self) {
      n.el.setAttribute("data-dragging", "");
      n.el.removeAttribute("data-shift");
      n.el.style.transform = `translateY(${selfShift}px)`;
    } else {
      n.el.removeAttribute("data-dragging");
      n.el.setAttribute("data-shift", "");
      n.el.style.transform = `translateY(${shifts.get(n.key) ?? 0}px)`;
    }
  }
  return measured.map((n) => n.el);
}

export interface DragSpec {
  /** 一覧（スクロールする要素）。作り直されない */
  scroller: HTMLElement;
  /** 動かす行のキー */
  self: string;
  /** 並びの全部の行（動かしている行も）を、いまの DOM から引き直して返す。呼ぶたびに引き直すこと */
  rows: () => DragRow[];
  /** true なら、つかんだ行を、全部の行の上端から下端までの内でしか動かさない（タブの行。帯の外で切れて見えなくならないように） */
  confine?: boolean;
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
  let marker: HTMLElement | null = null;
  let landing = 0; // 落ちる先の上端と、つかんだ行の元の上端の差（手を離したときに、ここまで動かす）

  // 行を動かす。行は作り直されることがあるので、毎回いまの DOM から引き直して掛け直す
  const update = () => {
    const measured = measureRows(spec.rows());
    const self = measured.find((n) => n.key === spec.self);
    if (!self) return;
    grabOffset ??= startY - self.top;
    const pos = dragPosition(
      measured,
      spec.self,
      y - grabOffset - self.top,
      spec.confine === true,
    )!;
    before = dropBefore(measured, spec.self, pos.probe, pos.down);
    const shifts = layoutShifts(measured, spec.self, before);
    const now = applyDrag(measured, spec.self, pos.shift, shifts);
    const top = dropTop(measured, spec.self, before, shifts);
    landing = top - self.top;
    const r = self.el.getBoundingClientRect();
    marker ??= makeSlotMarker();
    marker.style.left = `${r.left}px`;
    marker.style.width = `${r.width}px`;
    marker.style.top = `${top}px`;
    marker.style.height = `${r.height}px`;
    for (const el of marked) if (!now.includes(el)) clearRow(el);
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
    document.body.style.cursor = "";
    const settle = () => {
      marker?.remove();
      marker = null;
      for (const el of marked) clearRow(el);
      for (const r of spec.rows()) clearRow(r.el);
      if (wasActive && drop) spec.onDrop(before);
    };
    // 手を離したら、つかんだ行を落ちる先までなめらかに動かしてから並べ替える（視差効果を減らす設定なら、すぐ並べ替える）
    const self = marked.find((el) => el.hasAttribute("data-dragging"));
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (wasActive && drop && self && !reduce) {
      self.setAttribute("data-dropping", "");
      self.style.transform = `translateY(${landing}px)`;
      setTimeout(settle, DROP_MS + 20);
    } else {
      settle();
    }
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const key = (ev: KeyboardEvent) => {
    if (isComposingKey(ev)) return;
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
