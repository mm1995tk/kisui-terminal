// ターミナルを並べる配置（F4）。設計書 docs/design/gui-protocol.md の「ペインの配置」。
//
// - 配置は分割の木（PaneLayout）。葉が欄、節は「右に分ける（dir: "right"。a が左、b が右）」か
//   「下に分ける（dir: "down"。a が上、b が下）」。木は kisui serve が持ち、Workspace.layout で届く。
//   欄の数に上限は無い。分けられるかは serve が決める（分けた後の欄が最小の大きさを下回るなら断る）。
// - 木と実際の欄が食い違うとき（serve が古い・欄が閉じたばかり）は、reconcileLayout で欄に合わせる。
//   serve（server/layout.go）と同じ規則：無くなった欄は外して隣が埋め、木に無い欄は最後の欄を
//   交互の向き（右・下・右…）に分けて足す。
// - リーダーの h j k l で隣の欄へ移る。隣は、描かれる位置（layoutRects）で決める。
//
// DOM を使わないので node --test で確かめられる。

import type { PaneLayout, TreeDir } from "../rpc/protocol.ts";

/** 隣へ移る向き（リーダーの h j k l）。 */
export type Direction = "left" | "right" | "up" | "down";

/** 欄の位置。カードの左上を原点にした割合（0〜1）。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 木の葉の欄の id（左上から順）。 */
export function layoutPanes(n: PaneLayout | undefined): string[] {
  if (!n) return [];
  if ("pane" in n) return [n.pane];
  return [...layoutPanes(n.a), ...layoutPanes(n.b)];
}

function prune(
  n: PaneLayout | undefined,
  live: ReadonlySet<string>,
  seen: Set<string>,
): PaneLayout | undefined {
  if (!n) return undefined;
  if ("pane" in n) {
    if (!live.has(n.pane) || seen.has(n.pane)) return undefined;
    seen.add(n.pane);
    return n;
  }
  const a = prune(n.a, live, seen);
  const b = prune(n.b, live, seen);
  if (!a) return b;
  if (!b) return a;
  return a === n.a && b === n.b ? n : { ...n, a, b };
}

/** 自動で足すときに分ける欄と向き（最後の葉。深さが偶数なら右、奇数なら下）。 */
function autoTarget(n: PaneLayout): { target: string; dir: TreeDir } {
  let depth = 0;
  while (!("pane" in n)) {
    n = n.b;
    depth++;
  }
  return { target: n.pane, dir: depth % 2 === 0 ? "right" : "down" };
}

function split(
  n: PaneLayout,
  target: string,
  id: string,
  dir: TreeDir,
): PaneLayout {
  if ("pane" in n)
    return n.pane === target ? { dir, ratio: 0.5, a: n, b: { pane: id } } : n;
  return {
    ...n,
    a: split(n.a, target, id, dir),
    b: split(n.b, target, id, dir),
  };
}

/**
 * 木を、いまある欄（ids。先頭がプライマリ）に合わせる。無くなった欄は外して隣が埋め、木に無い欄は
 * 自動の場所に足す。木が無ければ（古い serve）全部自動。合っていれば同じ木を返す。
 */
export function reconcileLayout(
  layout: PaneLayout | undefined,
  ids: readonly string[],
): PaneLayout | undefined {
  const live = new Set(ids);
  let n = prune(layout, live, new Set());
  for (const id of ids) {
    if (!n) n = { pane: id };
    else if (!layoutPanes(n).includes(id)) {
      const t = autoTarget(n);
      n = split(n, t.target, id, t.dir);
    }
  }
  return n;
}

/** 木の欄ごとの位置。 */
export function layoutRects(
  n: PaneLayout | undefined,
  at: Rect = { x: 0, y: 0, w: 1, h: 1 },
  out = new Map<string, Rect>(),
): Map<string, Rect> {
  if (!n) return out;
  if ("pane" in n) {
    out.set(n.pane, at);
    return out;
  }
  const r = Math.min(Math.max(n.ratio, 0), 1);
  if (n.dir === "right") {
    layoutRects(n.a, { ...at, w: at.w * r }, out);
    layoutRects(n.b, { ...at, x: at.x + at.w * r, w: at.w * (1 - r) }, out);
  } else {
    layoutRects(n.a, { ...at, h: at.h * r }, out);
    layoutRects(n.b, { ...at, y: at.y + at.h * r, h: at.h * (1 - r) }, out);
  }
  return out;
}

const EPS = 1e-9;

/** a と b が辺を共有する範囲の長さ（区間 [a0, a0+al] と [b0, b0+bl] の重なり）。 */
function overlap(a0: number, al: number, b0: number, bl: number): number {
  return Math.min(a0 + al, b0 + bl) - Math.max(a0, b0);
}

/**
 * id から dir の向きの隣の欄の id。隣が無ければ undefined。辺が接している欄のうち、今の欄の
 * 上端（左右へ移るとき）か左端（上下へ移るとき）にかかるものを選び、無ければ重なりが一番長いもの。
 */
export function neighbor(
  rects: ReadonlyMap<string, Rect>,
  id: string,
  dir: Direction,
): string | undefined {
  const cur = rects.get(id);
  if (!cur) return undefined;
  const horizontal = dir === "left" || dir === "right";
  let best: { id: string; hit: boolean; len: number } | undefined;
  for (const [other, r] of rects) {
    if (other === id) continue;
    const touching =
      dir === "right"
        ? Math.abs(r.x - (cur.x + cur.w)) < EPS
        : dir === "left"
          ? Math.abs(r.x + r.w - cur.x) < EPS
          : dir === "down"
            ? Math.abs(r.y - (cur.y + cur.h)) < EPS
            : Math.abs(r.y + r.h - cur.y) < EPS;
    if (!touching) continue;
    const len = horizontal
      ? overlap(cur.y, cur.h, r.y, r.h)
      : overlap(cur.x, cur.w, r.x, r.w);
    if (len <= EPS) continue;
    const hit = horizontal
      ? r.y <= cur.y + EPS && cur.y < r.y + r.h - EPS
      : r.x <= cur.x + EPS && cur.x < r.x + r.w - EPS;
    if (
      !best ||
      (hit && !best.hit) ||
      (hit === best.hit && len > best.len + EPS)
    )
      best = { id: other, hit, len };
  }
  return best?.id;
}

// ---- 欄どうしの境界（#18）----
//
// 境界は、割合を持つ節（server/layout.go の layoutNode）。B 側の左上の葉の欄 id で指す（serve と同じ。
// 木のどの葉も、ちょうど 1 つの節の「B 側の左上」になるので一意で、ほかの欄を分けても変わらない）。

/** 欄を分けるときの、分けた後の欄の最小の大きさ（端末の列と行）。server/layout.go の minSplitCols・minSplitRows と同じ。 */
const MIN_COLS = 20;
const MIN_ROWS = 5;
/** 欄の大きさが分からないときの、割合の下限と上限（serve の fallbackRatioMin・fallbackRatioMax と同じ）。 */
const FALLBACK: readonly [number, number] = [0.05, 0.95];

/** 欄の間の隙間の幅（px）。境界のつまみはここにだけ置き、端末の字の上には重ねない。 */
export const GAP = 6;

/** 動かせる境界 1 つ。 */
export interface Bar {
  /** B 側の左上の葉の欄 id */
  key: string;
  dir: TreeDir;
  /** A の割合 */
  ratio: number;
  /** この節が占める範囲（カードに対する割合） */
  node: Rect;
}

/** 左上の葉の欄 id。 */
export function firstPane(n: PaneLayout): string {
  while (!("pane" in n)) n = n.a;
  return n.pane;
}

/** 木の境界（節）を、根から順に（節、A の中、B の中の順）。 */
export function layoutBars(
  n: PaneLayout | undefined,
  at: Rect = { x: 0, y: 0, w: 1, h: 1 },
  out: Bar[] = [],
): Bar[] {
  if (!n || "pane" in n) return out;
  const r = Math.min(Math.max(n.ratio, 0), 1);
  out.push({ key: firstPane(n.b), dir: n.dir, ratio: r, node: at });
  if (n.dir === "right") {
    layoutBars(n.a, { ...at, w: at.w * r }, out);
    layoutBars(n.b, { ...at, x: at.x + at.w * r, w: at.w * (1 - r) }, out);
  } else {
    layoutBars(n.a, { ...at, h: at.h * r }, out);
    layoutBars(n.b, { ...at, y: at.y + at.h * r, h: at.h * (1 - r) }, out);
  }
  return out;
}

/** key の境界の割合を ratio にした木（無ければ同じ木）。 */
export function withRatio(
  n: PaneLayout | undefined,
  key: string,
  ratio: number,
): PaneLayout | undefined {
  if (!n || "pane" in n) return n;
  if (firstPane(n.b) === key) return { ...n, ratio };
  const a = withRatio(n.a, key, ratio) as PaneLayout;
  const b = withRatio(n.b, key, ratio) as PaneLayout;
  return a === n.a && b === n.b ? n : { ...n, a, b };
}

/** 欄の列と行。分からなければ undefined（ターミナルでない欄）。 */
export type PaneSize = (
  id: string,
) => { cols: number; rows: number } | undefined;

function extent(
  n: PaneLayout,
  horiz: boolean,
  size: PaneSize,
): number | undefined {
  if ("pane" in n) {
    const s = size(n.pane);
    return s && (horiz ? s.cols : s.rows);
  }
  const a = extent(n.a, horiz, size);
  if (a === undefined) return undefined;
  if ((n.dir === "right") !== horiz) return a;
  const b = extent(n.b, horiz, size);
  return b === undefined ? undefined : a + b;
}

function minExtent(n: PaneLayout, horiz: boolean): number {
  if ("pane" in n) return horiz ? MIN_COLS : MIN_ROWS;
  const a = minExtent(n.a, horiz);
  const b = minExtent(n.b, horiz);
  return (n.dir === "right") === horiz ? a + b : Math.max(a, b);
}

/**
 * key の境界の割合の下限と上限。両側が最小の大きさ（MIN_COLS 列・MIN_ROWS 行）以上に残る範囲
 * （serve の ratioBounds と同じ計算）。大きさが分からなければ固定の範囲、すでに両側を満たせないほど小さければ undefined。
 */
export function ratioLimits(
  tree: PaneLayout | undefined,
  key: string,
  size: PaneSize,
): readonly [number, number] | undefined {
  const node = findNode(tree, key);
  if (!node) return undefined;
  const horiz = node.dir === "right";
  const a = extent(node.a, horiz, size);
  const b = extent(node.b, horiz, size);
  if (a === undefined || b === undefined || a + b <= 0) return FALLBACK;
  const lo = minExtent(node.a, horiz) / (a + b);
  const hi = 1 - minExtent(node.b, horiz) / (a + b);
  return lo <= hi ? [lo, hi] : undefined;
}

function findNode(
  n: PaneLayout | undefined,
  key: string,
): Extract<PaneLayout, { dir: TreeDir }> | undefined {
  if (!n || "pane" in n) return undefined;
  if (firstPane(n.b) === key) return n;
  return findNode(n.a, key) ?? findNode(n.b, key);
}

/** ratio を [lo, hi] に収め、0.1% の細かさに丸める（serve の clampRatio と同じ。丸めても範囲の中に残す）。 */
export function clampRatio(ratio: number, lo: number, hi: number): number {
  const r = Math.min(Math.max(ratio, lo), hi);
  let q = Math.round(r * 1000) / 1000;
  if (q < lo) q = Math.ceil(lo * 1000) / 1000;
  if (q > hi) q = Math.floor(hi * 1000) / 1000;
  return q;
}

/**
 * key の境界を ratio にしたときの割合（範囲に収めたもの）。動かせない（境界が無い・すでに小さすぎる）なら undefined。
 */
export function limitedRatio(
  tree: PaneLayout | undefined,
  key: string,
  ratio: number,
  size: PaneSize,
): number | undefined {
  const lim = ratioLimits(tree, key, size);
  return lim ? clampRatio(ratio, lim[0], lim[1]) : undefined;
}
