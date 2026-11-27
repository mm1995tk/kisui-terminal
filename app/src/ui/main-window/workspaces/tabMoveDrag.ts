// Workspace switcher（WorkspaceSwitcher.tsx。リーダーの w）の右の列のタブの行を、つかむ所からのドラッグで動かす（#308）。
// 同じワークスペースの中での並べ替えと、別のワークスペースへの移動を、同じドラッグでする。
// サイドバーの行の並べ替え（../sidebar/drag.ts）は「1 つの列の中で、行がよけて場所を空ける」作りで、つかんだ行が列の中に居続けることを前提にしている。
// ここでは、ドラッグ中に右の列が別のワークスペースのタブに替わる（つかんだ行は列から居なくなる）ので、別の作りにした：
// つかんだ行の写し（ゴースト）がポインタについて動き、入る位置には線を出す。行はよけない。
// - 左のワークスペースの行の上へ来たら onOver を呼ぶ（Dialog がその行を選び、右の列がそのワークスペースのタブに替わる）。
// - 右の列の上で離すと、線の位置（ポインタの高さより下にある最初の行の前。無ければ一番後ろ）に入る。空のワークスペースでは一番後ろ（＝最初）。
// - 左の行の上で離すと、そのワークスペースの一番後ろに入る。
// - それ以外の所で離す・Esc・Dialog からフォーカスが外れたら、やめる（onCancel）。
// 並びそのものは持たない（落とし先を呼ぶ側に返し、features/workspaces/tabs/controller.ts の moveTab が動かして覚える）。
// 落とし先を決めるのは、DOM を使わない関数（workspaceAt・dropTarget・insertBefore。node --test で確かめられる）。
// DOM を触るのは、行を測る measure*・結果を画面に出す show*・イベントを受け持つ startTabDrag。

import { isComposingKey } from "../../../features/commands/ime.ts";
import { DRAG_THRESHOLD, edgeScroll } from "../sidebar/drag.ts";

/** 右の列の 1 行（key は行を指すもの、top・bottom は画面での上端・下端）。 */
export interface InsertItem {
  key: string;
  top: number;
  bottom: number;
}

/** 入る位置（before は、その行のすぐ前。一番後ろなら null。y は線を出す高さ）。 */
export interface InsertAt {
  before: string | null;
  y: number;
}

/**
 * 高さ y に落としたとき、どの行の前に入るかと、線を出す高さ。items は上から順（つかんだ行 self も含んでよい）。
 * 行の真ん中より上なら、その行の前。つかんだ行は数えない（同じ列の中で動かすとき、自分の前には入れない）。
 * どの行の真ん中よりも下なら一番後ろ（線は最後の行の下端）。行が無ければ一番後ろで、線は emptyY（列の上端）。
 */
export function insertBefore(
  items: readonly InsertItem[],
  self: string,
  y: number,
  emptyY: number,
): InsertAt {
  const others = items.filter((it) => it.key !== self);
  for (const it of others)
    if (y < (it.top + it.bottom) / 2) return { before: it.key, y: it.top };
  const last = others.at(-1);
  return { before: null, y: last ? last.bottom : emptyY };
}

export interface TabDragSpec {
  /** つかんだタブの行（写しを作る元。ドラッグ中に作り直されてもよい） */
  row: HTMLElement;
  /** つかんだタブのキー（右の列の li.tab-row の data-key） */
  self: string;
  /** 左の一覧（ワークスペースの行 li.switch-row[data-gws] を持ち、スクロールする） */
  left: HTMLElement;
  /** 右の列（タブの行 li.tab-row[data-key] を持ち、スクロールする） */
  right: HTMLElement;
  /** 右の列が、いま出しているワークスペースの id */
  shown: () => string | undefined;
  /** 左のワークスペースの行の上へ来た。右の列を、そのワークスペースのタブに替える */
  onOver: (gws: string) => void;
  /** 落とした（ワークスペース gws の、before のタブの前。一番後ろなら null） */
  onDrop: (gws: string, before: string | null) => void;
  /** やめた（Esc・落とせない所で離した・Dialog からフォーカスが外れた） */
  onCancel: () => void;
}

/** 画面での矩形（DOMRect のうち、使う 4 つ）。 */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const inside = (r: Box, x: number, y: number) =>
  x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

/**
 * ポインタ（x, y）の下にある、左の一覧のワークスペースの行の id。無ければ undefined。
 * 左の一覧（list）はスクロールする。一覧からはみ出して見えていない行の矩形は一覧の箱の外にあるので、ポインタが一覧の中に無ければ当てない。
 */
export function workspaceAt(
  x: number,
  y: number,
  list: Box,
  rows: readonly { gws: string; box: Box }[],
): string | undefined {
  if (!inside(list, x, y)) return undefined;
  return rows.find((r) => inside(r.box, x, y))?.gws;
}

/** いま離したら入る先（ワークスペース gws の、before のタブの前。一番後ろなら null）。lineY は線を出す高さ（線を出さなければ null）。 */
export interface DropTarget {
  gws: string;
  before: string | null;
  lineY: number | null;
}

/**
 * ポインタ（x, y）で離したら入る先。落とせない所なら null。
 * - 左のワークスペースの行の上（over がある）：そのワークスペースの一番後ろ。線は出さない。
 * - 右の列（right）の中：右の列が出しているワークスペース（shown）の、insertBefore の位置。線は、右の列の見えている範囲に収める。
 * - どちらでもない：落とせない。
 * tabs は右の列のタブの行（上から順）、self はつかんだタブ。
 */
export function dropTarget(p: {
  x: number;
  y: number;
  over: string | undefined;
  shown: string | undefined;
  right: Box;
  tabs: readonly InsertItem[];
  self: string;
}): DropTarget | null {
  if (p.over !== undefined) return { gws: p.over, before: null, lineY: null };
  if (p.shown === undefined || !inside(p.right, p.x, p.y)) return null;
  const at = insertBefore(p.tabs, p.self, p.y, p.right.top);
  return {
    gws: p.shown,
    before: at.before,
    lineY: Math.min(Math.max(at.y, p.right.top), p.right.bottom),
  };
}

/** 左の一覧の、ワークスペースの行（いまの DOM）。 */
const leftRows = (left: HTMLElement) => [
  ...left.querySelectorAll<HTMLElement>("li.switch-row[data-gws]"),
];

/** 右の列の、タブの行（いまの DOM）。 */
const tabRows = (right: HTMLElement) => [
  ...right.querySelectorAll<HTMLElement>("li.tab-row[data-key]"),
];

/** ポインタの下にある、左の一覧のワークスペースの行の id（いまの DOM を測る）。 */
function measureOver(left: HTMLElement, x: number, y: number) {
  return workspaceAt(
    x,
    y,
    left.getBoundingClientRect(),
    leftRows(left).map((el) => ({
      gws: el.dataset.gws!,
      box: el.getBoundingClientRect(),
    })),
  );
}

/** 右の列のタブの行の位置（いまの DOM を測る）。 */
function measureTabs(right: HTMLElement): InsertItem[] {
  return tabRows(right).map((el) => {
    const r = el.getBoundingClientRect();
    return { key: el.dataset.key!, top: r.top, bottom: r.bottom };
  });
}

/** 落とすと入るワークスペースの行（over）と、つかんだタブの元の行（self）に印を付ける。ほかの行の印は外す。 */
function showMarks(
  spec: Pick<TabDragSpec, "left" | "right">,
  over: string | undefined,
  self: string | undefined,
) {
  for (const el of leftRows(spec.left))
    el.toggleAttribute(
      "data-drop-target",
      over !== undefined && el.dataset.gws === over,
    );
  for (const el of tabRows(spec.right))
    el.toggleAttribute(
      "data-drag-source",
      self !== undefined && el.dataset.key === self,
    );
}

/** 入る位置の線を、右の列の幅で、高さ y に出す（y が null なら隠す）。 */
function showLine(line: HTMLElement, right: Box, y: number | null) {
  line.style.display = y === null ? "none" : "";
  if (y === null) return;
  line.style.left = `${right.left}px`;
  line.style.width = `${right.right - right.left}px`;
  line.style.top = `${y}px`;
}

/**
 * 写しと線を置く親。Dialog（showModal した dialog）は一番上の層に出るので、body に置いたものは Dialog の下に隠れる。Dialog の中に置く
 * （position: fixed なので、Dialog の overflow では切られない）。
 */
const layerOf = (el: HTMLElement): HTMLElement =>
  el.closest<HTMLElement>("dialog") ?? document.body;

/** つかんだ行の写し。ポインタについて動く。右の列と同じ見た目になるよう、同じクラスの箱に入れる。 */
function makeGhost(row: HTMLElement, layer: HTMLElement): HTMLElement {
  const rect = row.getBoundingClientRect();
  const box = document.createElement("div");
  box.className = "switch-tabs tab-drag-ghost";
  box.setAttribute("aria-hidden", "true");
  box.style.width = `${rect.width}px`;
  box.style.setProperty(
    "--machine-color",
    getComputedStyle(row).getPropertyValue("--machine-color"),
  );
  const ul = document.createElement("ul");
  ul.className = "tab-rows";
  ul.appendChild(row.cloneNode(true));
  box.appendChild(ul);
  layer.appendChild(box);
  return box;
}

/** 入る位置の線。画面に固定して重ね、ポインタは通す。 */
function makeLine(layer: HTMLElement): HTMLElement {
  const l = document.createElement("div");
  l.className = "tab-drag-line";
  l.setAttribute("aria-hidden", "true");
  layer.appendChild(l);
  return l;
}

/**
 * タブの行のつかむ所を押したときに呼ぶ。以降の pointermove / pointerup / Esc を受け持ち、終われば全部外す。
 */
export function startTabDrag(e: PointerEvent, spec: TabDragSpec): void {
  if (e.button !== 0) return;
  e.preventDefault(); // 文字の選択やスクロールを始めない
  const startX = e.clientX;
  const startY = e.clientY;
  const rect = spec.row.getBoundingClientRect();
  const grab = { x: startX - rect.left, y: startY - rect.top };
  let x = startX;
  let y = startY;
  let active = false;
  let frame = 0;
  let ghost: HTMLElement | null = null;
  let line: HTMLElement | null = null;
  /** いま離したら入る先。落とせない所なら null */
  let target: DropTarget | null = null;

  // 印と線を、いまのポインタの位置に合わせる。行は作り直されることがあるので、毎回いまの DOM から引き直す
  const update = () => {
    if (!ghost || !line) return;
    ghost.style.left = `${x - grab.x}px`;
    ghost.style.top = `${y - grab.y}px`;
    const over = measureOver(spec.left, x, y);
    // 左の行の上へ来たら、右の列をそのワークスペースのタブに替える（Solid はその場で DOM を書き換えるので、このあとに右の列を測る）
    if (over !== undefined && over !== spec.shown()) spec.onOver(over);
    const right = spec.right.getBoundingClientRect();
    target = dropTarget({
      x,
      y,
      over,
      shown: spec.shown(),
      right,
      tabs: measureTabs(spec.right),
      self: spec.self,
    });
    showMarks(spec, over, spec.self);
    showLine(line, right, target?.lineY ?? null);
  };

  // 一覧の端にいるあいだは、フレームごとにスクロールする（ポインタがある方の一覧）
  const tick = () => {
    frame = 0;
    if (!active) return;
    const scroller = [spec.right, spec.left].find((el) =>
      inside(el.getBoundingClientRect(), x, y),
    );
    if (!scroller) return;
    const r = scroller.getBoundingClientRect();
    const dy = edgeScroll(y, r.top, r.bottom);
    const before = scroller.scrollTop;
    if (dy !== 0) scroller.scrollTop += dy;
    if (scroller.scrollTop === before) return;
    update();
    frame = requestAnimationFrame(tick);
  };

  const move = (ev: PointerEvent) => {
    x = ev.clientX;
    y = ev.clientY;
    if (!active) {
      if (Math.hypot(x - startX, y - startY) < DRAG_THRESHOLD) return;
      active = true;
      const layer = layerOf(spec.right);
      ghost = makeGhost(spec.row, layer);
      line = makeLine(layer);
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
    document.body.style.cursor = "";
    ghost?.remove();
    line?.remove();
    showMarks(spec, undefined, undefined);
    if (!wasActive) return;
    if (drop && target) spec.onDrop(target.gws, target.before);
    else spec.onCancel();
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
