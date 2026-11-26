// メインウィンドウの境界の大きさと、サイドバーの開閉（表示用の状態）。値の決まりは panes.ts にあり、ここは画面の要素を読んで動かす。
// - サイドバーの幅・タブの段とファイルツリーの境目・ファイルツリーと CHANGES の境目を、ドラッグとリサイズモード（Cmd+R / Ctrl+Shift+R）で動かす。
// - サイドバーを開ける・閉じる（リーダーの b）。
// - ファイルツリーのスクロールの位置を、ワークスペースごとに覚えて戻す（覚えるのは features/file-tree/）。
// 変えた値は覚えておき、GUI を起動し直しても残す。
import {
  createEffect,
  createSignal,
  on,
  untrack,
  type Accessor,
} from "solid-js";

import type { KeyValueStore } from "../../features/keyValueStore.ts";
import type { Bar } from "../../features/terminal/grid.ts";
import type { TermGroup } from "../../features/terminal/group.ts";
import {
  focusedRow,
  shownIsPage,
  type Row,
  type WorkspaceFocus,
} from "../../features/workspaces/rows.ts";
import type { WorkspaceId } from "../../infrastructure/rpc/protocol.ts";
import type { WindowEls } from "./els.ts";
import { termCellWidth } from "./termCell.ts";
import {
  applyMove,
  changesMax,
  CHANGES_BORDER,
  KEY_STEP,
  LIMITS,
  loadSidebarOpen,
  loadSizes,
  resizeAction,
  saveSidebarOpen,
  saveSizes,
  sidebarMax,
  SPLIT_KEY_STEP,
  sizeOf,
  TABS_BORDER,
  withoutSize,
  withSize,
  type Border,
  type PaneSizes,
} from "./panes.ts";

/** createPaneResize が返す持ち物。 */
export type PaneResize = ReturnType<typeof createPaneResize>;

/** 境界の大きさとサイドバーの開閉の持ち物を作る。覚えておいた値で始め、ドラッグとリサイズモードのキーで動かし、変えるたびに覚える。 */
export function createPaneResize(deps: {
  store: KeyValueStore | undefined;
  /** タブの段の高さの上限の元の値（設定の [gui.sidebar] tabs-height。サイドバーの高さに対する %）。無ければ 40 */
  tabsHeight: number | undefined;
  els: WindowEls;
  focus: Accessor<WorkspaceFocus | null>;
  /** サイドバーの行（ワークスペースの並び） */
  rows: Accessor<Row[]>;
  /** DB のタブを出しているか（出している間は、サイドバーのファイルツリーの場所に DB の木が出る。#374） */
  dbShown: () => boolean;
  /** フォーカスしているワークスペースのターミナル */
  termGroup: () => TermGroup | undefined;
  /** ペインどうしの境界（隠している間は無い） */
  termBars: () => readonly Bar[];
  /** ワークスペースの CHANGES の一覧（出していなければ undefined） */
  changesOf: (target: string, id: WorkspaceId) => unknown;
  /** workspace.step で続けて移っている間か（この間はツリーを出さない） */
  walking: Accessor<boolean>;
  /** フォーカスしているワークスペースのツリーで覚えているスクロールの位置 */
  treeScrollTop: () => number | undefined;
  /** フォーカスしているワークスペースのツリーのスクロールの位置を覚える */
  rememberTreeScroll: (top: number) => void;
  /** 今使っているペインにキーを向ける */
  focusTerminal: () => void;
}) {
  const {
    store,
    els,
    focus,
    rows,
    termGroup,
    termBars,
    changesOf,
    walking,
    dbShown,
    focusTerminal,
  } = deps;
  // ブロックの境界の大きさ（panes.ts）。変えたら覚えておき、GUI を起動し直しても残す
  const [sizes, setSizes] = createSignal<PaneSizes>(loadSizes(store));
  function changeSizes(next: PaneSizes) {
    setSizes(next);
    saveSizes(store, next);
  }
  // サイドバーを開けているか（リーダーの b）。閉じるのは b を押したときだけ。覚えておき、GUI を起動し直しても残す
  const [sidebarOpen, setSidebarOpen] = createSignal(loadSidebarOpen(store));
  function changeSidebarOpen(open: boolean) {
    setSidebarOpen(open);
    saveSidebarOpen(store, open);
  }
  /** b：閉じているなら開く。開けているなら閉じる（キーがサイドバーの中にあれば、見えなくなる前にターミナルへ戻す）。 */
  function toggleSidebar() {
    if (sidebarOpen()) {
      if (els.nav?.contains(document.activeElement)) focusTerminal();
      changeSidebarOpen(false);
      return;
    }
    changeSidebarOpen(true);
    // display: none の間にスクロールの位置は 0 に戻るので、今のワークスペースで覚えている位置に戻す
    restoreTreeScroll();
  }
  /** 今のワークスペースのツリーで覚えている位置に、サイドバーのスクロールを戻す（描き直しのあと）。 */
  function restoreTreeScroll() {
    const top = deps.treeScrollTop();
    if (top !== undefined) restoreScrollTo(top);
  }
  /** ファイルツリーのスクロールの位置を top に戻す（描き直しのあと）。 */
  function restoreScrollTo(top: number) {
    requestAnimationFrame(() => {
      const el = treeScroller();
      if (el) el.scrollTop = top;
    });
  }
  // リサイズモード（Cmd+R / Ctrl+Shift+R・パレットの「リサイズ」）か。境界を動かすキーは GUI が受ける
  const [resizeMode, setResizeMode] = createSignal(false);
  // リサイズモードで動かす境界（光らせる）。ドラッグ中の境界も光る
  const [dragging, setDragging] = createSignal<Border | null>(null);
  // リサイズモードで動かしている境界：サイドバー（null）か、欄どうしの境界（grid.ts の key）。入るたびにサイドバーから始める
  const [resizeSel, setResizeSel] = createSignal<string | null>(null);
  createEffect(
    on(resizeMode, (m) => {
      if (!m) setResizeSel(null);
    }),
  );
  // リサイズモードで選んでいる境界が無くなったら（欄を閉じた）サイドバーに戻す
  const litSplit = () => {
    const k = resizeSel();
    return resizeMode() && k !== null && termBars().some((b) => b.key === k)
      ? k
      : undefined;
  };
  // ファイルツリーと CHANGES の境目をリサイズモードで選んでいるか（CHANGES が出ていないときは選べない）
  const litChanges = () =>
    resizeMode() && resizeSel() === CHANGES_BORDER && changesShown();
  // タブの段とファイルツリーの境目をリサイズモードで選んでいるか（3 段に分けているときだけ選べる）
  const litTabs = () =>
    resizeMode() && resizeSel() === TABS_BORDER && tabsShown();
  const lit = (b: Border) =>
    dragging() === b ||
    (b === "changes"
      ? litChanges()
      : b === "tabs"
        ? litTabs()
        : resizeMode() &&
          litSplit() === undefined &&
          !litChanges() &&
          !litTabs());
  // ツリーを出し直したら、そのワークスペースで覚えている位置に戻す（出していない間は、スクロールの位置が合わない）
  createEffect(
    on(walking, (w, prev) => {
      if (w || !prev) return;
      restoreTreeScroll();
    }),
  );

  /** 今の窓で効く境界の上限（layout.css の clamp・changes.css の max-height と同じ決まり。panes.ts の sidebarMax・changesMax）。 */
  function maxOf(b: Border = "sidebar"): number {
    if (b === "tabs") return LIMITS.tabs[1];
    return b === "changes"
      ? changesMax(window.innerHeight)
      : sidebarMax(window.innerWidth, termCellWidth());
  }

  /** タブの段の高さの上限の今の値（%）。決めていなければ設定の [gui.sidebar] tabs-height、それも無ければ 40。 */
  const tabsPct = () => sizeOf(sizes(), "tabs", deps.tabsHeight);

  /** 画面に出ているタブの段の高さ（サイドバーの高さに対する %）と、ポインタ 1px あたりの %。段が出ていなければ undefined。 */
  function shownTabs(): { pct: number; perPx: number } | undefined {
    const ul = els.app?.querySelector<HTMLElement>(".tab-rows");
    const box = ul?.closest<HTMLElement>(".band-item");
    if (!ul || !box || !tabsShown()) return undefined;
    const total = box.getBoundingClientRect().height;
    if (total <= 0) return undefined;
    return {
      pct: (ul.getBoundingClientRect().height / total) * 100,
      perPx: 100 / total,
    };
  }

  /** sizes の tabs を、画面に出ているタブの段の高さにしたもの（出ていなければ、今の値のまま）。 */
  function withShownTabs(s: PaneSizes): PaneSizes {
    const t = shownTabs();
    return withSize(s, "tabs", t ? t.pct : tabsPct(), maxOf("tabs"));
  }

  /** 画面に出ている CHANGES の一覧の高さ。一覧が無ければ undefined。 */
  function shownChangesHeight(): number | undefined {
    return els.app
      ?.querySelector<HTMLElement>(".changes-list")
      ?.getBoundingClientRect().height;
  }

  /** sizes の changes を、画面に出ている一覧の高さにしたもの（出ていなければそのまま）。 */
  function withShownHeight(s: PaneSizes): PaneSizes {
    const h = shownChangesHeight();
    return h === undefined ? s : withSize(s, "changes", h, maxOf("changes"));
  }

  /** リサイズモードで、タブの段とファイルツリーの境目を動かす。上下だけ効く（下へ動かすとタブの段が高くなる）。 */
  function nudgeTabs(axis: "x" | "y", sign: 1 | -1) {
    if (axis !== "y") return;
    changeSizes(
      applyMove(
        // 動かし始めは、画面に出ているタブの段の高さ（タブが少なく、上限より低いとき、見えない値だけが動かないように）
        withShownTabs(sizes()),
        "tabs",
        sign * KEY_STEP.tabs,
        maxOf("tabs"),
      ),
    );
  }

  /** リサイズモードで、ファイルツリーと CHANGES の境目を動かす。上下だけ効く（上へ動かすと CHANGES が高くなる）。 */
  function nudgeChanges(axis: "x" | "y", sign: 1 | -1) {
    if (axis !== "y") return;
    changeSizes(
      applyMove(
        // 動かし始めは、画面に出ている一覧の高さ（行が少なく、覚えた値より低いとき、見えない値だけが動かないように）
        withShownHeight(sizes()),
        "changes",
        -sign * KEY_STEP.changes,
        maxOf("changes"),
      ),
    );
  }

  /** リサイズモードで key（TUI と同じ名前。panes.ts）を押した。 */
  function resizeKey(key: string) {
    const a = resizeAction(key);
    switch (a.kind) {
      case "nudge": {
        if (litTabs()) {
          nudgeTabs(a.axis, a.sign);
          break;
        }
        if (litChanges()) {
          nudgeChanges(a.axis, a.sign);
          break;
        }
        const k = litSplit();
        if (k === undefined) {
          if (a.axis === "x")
            changeSizes(
              applyMove(sizes(), "sidebar", a.sign * KEY_STEP.sidebar, maxOf()),
            );
          break;
        }
        // 縦の境界（右に分けた欄の間）は左右、横の境界は上下だけ動かす
        const bar = termBars().find((b) => b.key === k);
        if (bar && (bar.dir === "right") === (a.axis === "x"))
          termGroup()?.setBorder(k, bar.ratio + a.sign * SPLIT_KEY_STEP);
        break;
      }
      case "select": {
        // サイドバーの幅、タブの段とファイルツリーの境目（3 段に分けているとき）、ファイルツリーと CHANGES の境目（CHANGES が出ているとき）、ペインどうしの境界（木の順）の順に回す
        const order: (string | null)[] = [
          null,
          ...(tabsShown() ? [TABS_BORDER] : []),
          ...(changesShown() ? [CHANGES_BORDER] : []),
          ...termBars().map((b) => b.key),
        ];
        const cur = litTabs()
          ? TABS_BORDER
          : litChanges()
            ? CHANGES_BORDER
            : (litSplit() ?? null);
        const i = order.indexOf(cur);
        setResizeSel(order[(i + a.step + order.length) % order.length]);
        break;
      }
      case "reset": {
        if (litTabs()) {
          changeSizes(withoutSize(sizes(), "tabs"));
          break;
        }
        if (litChanges()) {
          changeSizes(withoutSize(sizes(), "changes"));
          break;
        }
        const k = litSplit();
        if (k === undefined) changeSizes(withoutSize(sizes(), "sidebar"));
        else termGroup()?.setBorder(k, 0.5);
        break;
      }
      case "exit":
        setResizeMode(false);
        break;
    }
  }

  /**
   * 境界をつかんで動かす間の、ポインタの受け持ち。つかんだら border を光らせ、動くたびに move を呼び、離したら片付ける。
   * 境界の値の計算（move の中身）は、動かす境界ごとに渡す。
   */
  function trackPointer(
    border: Border,
    e: PointerEvent,
    move: (ev: PointerEvent) => void,
  ) {
    const el = e.currentTarget as HTMLElement;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    setDragging(border);
    const end = () => {
      setDragging(null);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  /** サイドバーの境界のドラッグ。ポインタの位置が境界。 */
  function dragBorder(border: "sidebar", e: PointerEvent) {
    const box = els.app;
    if (e.button !== 0 || !box) return;
    // つまみは境界の右の隙間にあるので、つかんだ位置と境界の差を覚えて、動かし始めに境界が跳ねないようにする
    // （境界の位置は、覚えた値ではなく画面に出ているつまみの左端から取る。窓が狭いと CSS が幅を縮めているため）
    const grab =
      e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left;
    trackPointer(border, e, (ev) => {
      const r = box.getBoundingClientRect();
      changeSizes(
        withSize(sizes(), border, ev.clientX - r.left - grab, maxOf()),
      );
    });
  }

  /**
   * ファイルツリーと CHANGES の境目のドラッグ。上へ動かすと CHANGES の一覧が高くなる。
   * 動かし始めの高さは、画面に出ている一覧の高さ（行が少ないと、決めた高さより低い）。
   */
  function dragChanges(e: PointerEvent, height: number) {
    if (e.button !== 0) return;
    const startY = e.clientY;
    trackPointer("changes", e, (ev) => {
      changeSizes(
        withSize(
          sizes(),
          "changes",
          height + (startY - ev.clientY),
          maxOf("changes"),
        ),
      );
    });
  }

  /**
   * タブの段とファイルツリーの境目のドラッグ。下へ動かすとタブの段が高くなる。
   * 動かし始めの高さは、画面に出ているタブの段の高さ（タブが少ないと、決めた上限より低い）。
   */
  function dragTabs(e: PointerEvent) {
    if (e.button !== 0) return;
    const t = shownTabs();
    if (!t) return;
    const startY = e.clientY;
    trackPointer("tabs", e, (ev) => {
      changeSizes(
        withSize(
          sizes(),
          "tabs",
          t.pct + (ev.clientY - startY) * t.perPx,
          maxOf("tabs"),
        ),
      );
    });
  }

  /** ファイルツリーをスクロールする要素（3 段のサイドバーのファイルツリーの段。#284）。出ていなければ undefined。 */
  function treeScroller(): HTMLElement | undefined {
    return (
      els.nav?.querySelector<HTMLElement>(
        ".tree-section:not(.db-tree-section)",
      ) ?? undefined
    );
  }

  function rememberScroll(e: Event) {
    // 一覧（nav）の中のスクロールを、キャプチャで全部受ける。覚えるのはファイルツリーの段のものだけ
    if (e.target !== treeScroller()) return;
    if (untrack(walking)) return; // ツリーを出していない間の位置は、ツリーのものではない
    deps.rememberTreeScroll((e.target as HTMLElement).scrollTop);
  }

  /** サイドバーに CHANGES が出ているか（ファイルツリーとの境目を動かせるか）。サイドバーを閉じている間は出ていない。 */
  function changesShown(): boolean {
    const f = focus();
    return (
      sidebarOpen() &&
      !dbShown() &&
      f !== null &&
      changesOf(f.target, f.id) !== undefined
    );
  }

  /** サイドバーを 3 段（タブ・ファイルツリー（DB のタブを出している間は DB の木）・CHANGES）に分けて出しているか（タブの段との境目を動かせるか）。ブラウザのタブを出している間は出さない。 */
  function tabsShown(): boolean {
    const r = focusedRow(rows());
    return (
      sidebarOpen() &&
      r !== null &&
      (dbShown() || (r.row.band.showTree && !shownIsPage(r.row.tabs)))
    );
  }

  return {
    /** 境界の大きさ（覚えている値） */
    sizes,
    /** 境界 b を元の大きさに戻す（つまみのダブルクリック） */
    resetSize: (b: Border) => changeSizes(withoutSize(sizes(), b)),
    tabsPct,
    /** サイドバーを開けているか（リーダーの b） */
    sidebarOpen,
    changeSidebarOpen,
    toggleSidebar,
    restoreScrollTo,
    /** リサイズモード（Cmd+R / Ctrl+Shift+R）か */
    resizeMode,
    setResizeMode,
    /** 境界 b を光らせるか（リサイズモードで選んでいる・ドラッグしている） */
    lit,
    /** リサイズモードで選んでいる、ペインどうしの境界（無ければ undefined） */
    litSplit,
    resizeKey,
    dragBorder,
    dragChanges,
    dragTabs,
    rememberScroll,
  };
}
