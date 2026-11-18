// 内蔵ブラウザのタブ（#202）の持ち物。タブの中身（URL・題・表示の大きさ）と、ワークスペースごとに何を出しているか。
// 開いていたタブは殻がデータのフォルダに覚え、再起動したら戻す（tabs.ts・browser.rs）。
// 画面にも Tauri にも触らない。殻への頼みは BrowserOs（os.ts）で受け取る。
import { createSignal, onCleanup, untrack } from "solid-js";

import type { BrowserOs } from "./os.ts";
import { EMPTY_TABS, fromStored, toStored, type TabsState } from "./tabs.ts";

/** createBrowserTabs が返す持ち物。 */
export type BrowserTabs = ReturnType<typeof createBrowserTabs>;

/** ブラウザのタブの持ち物を作る。タブの中身と、ワークスペースごとに何を出しているかを持ち、変わったら少し待ってから殻に覚えさせる。 */
export function createBrowserTabs(deps: {
  os: Pick<BrowserOs, "loadTabs" | "saveTabs">;
}) {
  const { loadTabs, saveTabs } = deps.os;
  // 内蔵ブラウザのタブ（#202）は GUI のワークスペースに属する。タブの中身と、ワークスペースごとに何を出しているかは tabs に持つ
  const [tabs, setTabsState] = createSignal<TabsState>(EMPTY_TABS);
  /** 覚えていたブラウザのタブを読み終えたか（読む前の空のまま、ワークスペースの記録からブラウザのタブを外さないため） */
  const [tabsReady, setTabsReady] = createSignal(false);
  /** 覚えていたタブを読み終えたか（読む前に空のまま書いて、覚えていたものを消さないため） */
  let tabsLoaded = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function setTabs(next: TabsState | ((t: TabsState) => TabsState)) {
    const before = untrack(tabs);
    const v = typeof next === "function" ? next(before) : next;
    if (v === before) return;
    setTabsState(v);
    if (!tabsLoaded) return;
    // ページの遷移のたびに書かないよう、少し待ってまとめて書く
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void saveTabs(toStored(untrack(tabs))).catch((e: unknown) =>
        console.warn("browser tabs:", e),
      );
    }, 500);
  }
  onCleanup(() => clearTimeout(saveTimer));

  /** 覚えていたタブを読む（起動したときに 1 回）。読めなくても、読み終えたことにする（空から始める）。 */
  async function load(): Promise<void> {
    try {
      // 閉じたワークスペースのタブは、reconcile が捨てる（読み終えたあと、一覧が分かっていれば）
      const t = fromStored(await loadTabs());
      // 読むあいだに開いたタブも残す
      const opened = untrack(tabs);
      setTabsState({
        tabs: [...t.tabs, ...opened.tabs],
        views: opened.views,
      });
    } catch (e) {
      console.warn("browser tabs:", e);
    }
    tabsLoaded = true;
    setTabsReady(true);
  }

  return {
    tabs,
    setTabs,
    /** 覚えていたブラウザのタブを読み終えたか */
    tabsReady,
    load,
  };
}
