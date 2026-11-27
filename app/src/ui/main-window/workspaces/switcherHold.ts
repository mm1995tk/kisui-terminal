// Workspace switcher（WorkspaceSwitcher.tsx）で、キーでタブをつかんで別のワークスペースへ移す間の状態（m → j k h l → Enter。#332）。
// つかんでいる間は、並びを変えない。右の列に「つかんだタブが入る位置」を出して見せるだけで、落とすと初めて、呼んだ側が動かす（ドラッグと同じ onTabMove）。
// 位置の計算は DOM も Solid も使わない関数（node --test で確かめる）。

import { createSignal } from "solid-js";

import type { TabItem } from "../../../features/workspaces/rows.ts";

/** つかんでいるタブ。from・index は、つかんだときのワークスペースと位置（やめたら・元に戻ったら、ここへ戻す）。 */
export interface Hold {
  tab: TabItem;
  from: string;
  /** つかんだときの位置（つかんだタブを除いた並びでの、入る位置でもある） */
  index: number;
}

/** 並びからつかんだタブを除いたもの（つかんだタブの入る位置は、この並びの何番目の前かで数える）。 */
export function without<T extends { key: string }>(
  items: readonly T[],
  key: string,
): T[] {
  return items.filter((t) => t.key !== key);
}

/** 移す先のワークスペースを選んだときの、入る位置（元のワークスペースなら元の位置、別なら一番後ろ）。items はそのワークスペースのタブ。 */
export function startPos(
  hold: Hold,
  gws: string,
  items: readonly { key: string }[],
): number {
  return gws === hold.from ? hold.index : without(items, hold.tab.key).length;
}

/** 入る位置を 1 つ動かす（端では止まる）。count は、つかんだタブを除いたタブの数。 */
export function stepPos(pos: number, to: "next" | "prev", count: number) {
  return Math.min(count, Math.max(0, pos + (to === "next" ? 1 : -1)));
}

/** 右の列に出すタブ。つかんだタブを、入る位置に出す。 */
export function holdItems(
  items: readonly TabItem[],
  hold: Hold,
  pos: number,
): TabItem[] {
  const rest = without(items, hold.tab.key);
  const at = Math.min(Math.max(0, pos), rest.length);
  return [...rest.slice(0, at), hold.tab, ...rest.slice(at)];
}

/**
 * 落としたときに動かす先。ワークスペース gws の、before のタブの前（一番後ろなら null）。
 * 元のワークスペースの元の位置のままなら、何も変えないので null を返す。
 */
export function dropTarget(
  hold: Hold,
  gws: string,
  items: readonly { key: string }[],
  pos: number,
): { gws: string; before: string | null } | null {
  if (gws === hold.from && pos === hold.index) return null;
  return {
    gws,
    before: without(items, hold.tab.key)[pos]?.key ?? null,
  };
}

/** つかんでいる間の状態（held・pos）。並びは持たない。 */
export function createSwitcherHold() {
  const [held, setHeld] = createSignal<Hold>();
  const [pos, setPos] = createSignal(0);
  return {
    held,
    pos,
    setPos,
    /** つかむ（入る位置は、今の位置から） */
    start(tab: TabItem, from: string, index: number) {
      setPos(index);
      setHeld({ tab, from, index });
    },
    /** つかむのをやめる（元の所へ戻すのは呼んだ側） */
    stop: () => setHeld(undefined),
  };
}
