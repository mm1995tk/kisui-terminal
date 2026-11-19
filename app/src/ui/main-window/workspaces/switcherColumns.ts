// ワークスペースを切り替える窓（WorkspaceSwitcher.tsx）の 2 つの列：キーが効いている列と、右の列で選んでいるタブ。
import { createMemo, createSignal } from "solid-js";

import type { Row, TabItem } from "../../../features/workspaces/rows.ts";
import { moveRow } from "../../../features/sessions/machineList.ts";

/** キーが効いている列（左がワークスペース、右がそのタブ） */
export type Col = "ws" | "tab";

/**
 * 列とタブの選択を持つ。selected は、左で選んでいるワークスペース。
 * タブの列に移れるのは、そのワークスペースにタブがあるときだけ（col が "tab" のままでも、タブが無ければ左にいるものとして扱う）。
 * 右の列で選んでいるタブは、そのワークスペースに無い key なら、出しているタブ、それも無ければ先頭を選んでいるものとする。
 */
export function createSwitcherColumns(selected: () => Row | undefined) {
  const [col, setCol] = createSignal<Col>("ws");
  const [tabSel, setTabSel] = createSignal<string | undefined>();
  const tabs = (): readonly TabItem[] => selected()?.tabs.items ?? [];
  /** いまキーが効いている列 */
  const activeCol = (): Col =>
    col() === "tab" && tabs().length > 0 ? "tab" : "ws";
  const tabIndex = createMemo((): number => {
    const items = tabs();
    if (items.length === 0) return -1;
    const at = (k: string | undefined) => items.findIndex((t) => t.key === k);
    return Math.max(
      0,
      at(tabSel()) >= 0 ? at(tabSel()) : at(selected()?.tabs.shown),
    );
  });
  /** 右の列で選んでいるタブ（タブが無ければ undefined） */
  const selectedTab = (): TabItem | undefined => tabs()[tabIndex()];
  return {
    tabs,
    activeCol,
    selectedTab,
    /** ワークスペースの列へ移る */
    toWs: () => setCol("ws"),
    /** タブの列へ移る（タブが無ければ移らない） */
    toTabs: () => {
      if (tabs().length > 0) setCol("tab");
    },
    /** タブの列で、選ぶタブを動かす（端では止まる） */
    moveTab: (to: "next" | "prev") =>
      setTabSel(tabs()[moveRow(tabIndex(), to, tabs().length)]?.key),
    /** タブを選んで、タブの列へ移る */
    pickTab: (key: string) => {
      setTabSel(key);
      setCol("tab");
    },
  };
}
