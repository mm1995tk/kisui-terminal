// ターミナルを並べる配置（F4）。設計書 docs/design/gui-protocol.md の「欄の配置」。
//
// - 配置は分割の木（PaneLayout）。葉が欄、節は「右に分ける（dir: "right"。a が左、b が右）」か
//   「下に分ける（dir: "down"。a が上、b が下）」。木は kisui serve が持ち、Workspace.layout で届く。
//   欄の数に上限は無い。分けられるかは serve が決める（分けた後の欄が最小の大きさを下回るなら断る）。
// - 木と実際の欄が食い違うとき（serve が古い・欄が閉じたばかり）は、reconcileLayout で欄に合わせる。
//   serve（server/layout.go）と同じ規則：無くなった欄は外して隣が埋め、木に無い欄は最後の欄を
//   交互の向き（右・下・右…）に分けて足す。
// - Ctrl+Shift+矢印で隣の欄へ移る。隣は、描かれる位置（layoutRects）で決める。
//
// DOM を使わないので node --test で確かめられる。

import {
  isCmdKey,
  isCmdOptionKey,
  isCmdShiftKey,
  isCmdZoomKey,
  isCtrlShift,
  type KeyLike,
} from "../guiKeys.ts";
import type { PaneLayout, SplitDir } from "../rpc/protocol.ts";

/** 隣へ移る向き（Ctrl+Shift+矢印）。 */
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
function autoTarget(n: PaneLayout): { target: string; dir: SplitDir } {
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
  dir: SplitDir,
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

/** Ctrl+Shift+矢印（Mac は Cmd+Option+矢印も）なら向き、そうでなければ null。 */
export function directionKey(e: KeyLike, mac = false): Direction | null {
  if (!(isCtrlShift(e) || (mac && isCmdOptionKey(e)))) return null;
  switch (e.key) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    default:
      return null;
  }
}

/**
 * 今の欄を分けるキー。Mac は Cmd+D で右、Cmd+Shift+D で下（iTerm2 と同じ）。
 * ほかは Ctrl+Shift+D で右、Ctrl+Shift+E で下。分けないキーなら null。
 */
export function splitKey(e: KeyLike, mac = false): SplitDir | null {
  if (mac) {
    if (isCmdKey(e, "d")) return "right";
    if (isCmdShiftKey(e, "d")) return "down";
    return null;
  }
  if (!isCtrlShift(e)) return null;
  if (e.code === "KeyD" || e.key === "D" || e.key === "d") return "right";
  if (e.code === "KeyE" || e.key === "E" || e.key === "e") return "down";
  return null;
}

/** プライマリ以外の欄を隠す・戻すキー（Ctrl+Shift+M。Mac は Cmd+Shift+Enter も）か。 */
export function isZoomKey(e: KeyLike, mac = false): boolean {
  if (mac && isCmdZoomKey(e)) return true;
  if (!isCtrlShift(e)) return false;
  return e.code === "KeyM" || e.key === "M" || e.key === "m";
}
