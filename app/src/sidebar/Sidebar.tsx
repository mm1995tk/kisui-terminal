// 左の一覧（D1）：GUI のワークスペース（gws/model.ts。#231）の帯を 1 列に並べる（#201）。マシンの見出しは無い。帯を押すとフォーカスを移す。
// 並び順はユーザーが並べた順（リーダーの w J / w K で動かす）。マシンをまたいで 1 列になる。
// 各帯には、そのワークスペースが今出しているターミナルのタブのマシンの名前と接続の状態（丸）を小さく出す。つながっていないマシンのタブは、最後に分かった名前で薄く出す。
// フォーカスしているワークスペースの帯の下にはツリーを出す（プライマリで shj が動いているときだけ。動いていなければ帯だけ）（D2、描くのは tree/TreeView.tsx）。
// スクロールしても、上にフォーカスしている帯と親フォルダを、下にそれより後ろの帯を固定する（D3）。
// マシンごとの色（D4）は帯の --machine-color に入れ、タブの行のマシンの札とフォーカスの輪郭に使う。
// 帯の右の [×] は、押すと onClose を呼ぶ（ワークスペースを閉じる。中のターミナルのタブも閉じる。確認は App が窓で出す）。
// 一覧の一番下の「+ ワークスペースを作る」は、押すと onNew を呼ぶ（どのマシンに作るかは App が窓で選ばせる）。
// マシンの操作（足す・名前を変える・外す・切る・つなぎ直す）は、サイドバーではなくマシンのダイアログ（リーダーの m）にある。
// ワークスペースの帯の右クリックのメニューの「名前を変える」と、帯の鉛筆のボタンは、onRenameWorkspace を呼ぶ。
// App が renaming を渡すと、その帯の 1 行目の名前がその場で入力欄になる（Enter で onRenameSubmit、Esc・フォーカスが外れたら onRenameCancel）。
// 帯はヘッダー（つかむ所・畳む / 開く・名前・「+」・鉛筆・✕）とコンテンツ（タブの行。ターミナルのタブも内蔵ブラウザ（#202）のタブも、開いた順に 1 つの並びで）に分ける（#234）。
// タブの行を押すと onTab、行の ✕ で onTabClose、鉛筆で onTabRename、ヘッダーの ▾ / ▸ で onTabsFold（並びを畳む・開く）。タブを出していれば、その行を光らせる。
// ヘッダーの「+」は小さなメニューを出し、選んだものを onAddTab に渡す（ターミナル・ターミナル（マシンを選ぶ）・ブラウザ）。
// ファイルツリーと CHANGES は、今出しているターミナルのタブの行のすぐ下（その行の中）に開く。
// ブラウザのタブを出している間は、ファイルツリーと CHANGES を見えなくする（外さないので、開いているフォルダ・選んでいる行・境目の位置は残る。#268）。
// 選んでも帯・行の位置と高さが変わらないよう、鉛筆・✕・つかむ所は出ていないときも場所を空けておく（sidebar.css）。
// 組み立ては model.ts、並び順は order.ts、色の決め方は colors.ts、見た目は sidebar.css。
import { T } from "../i18n/index.ts";
import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";

import type { ChangesShjKey, WorkspaceId } from "../rpc/protocol.ts";
import type { TreeRow } from "../tree/model.ts";
import { menuItems, type TreeMenuAction } from "../tree/menu.ts";
import { TreeMenu } from "../tree/TreeMenu.tsx";
import { ChangesView } from "../changes/ChangesView.tsx";
import type { ChangeRow, ChangesBase } from "../changes/model.ts";
import { renameKeyAction } from "./renameInput.ts";
import { TreeView } from "../tree/TreeView.tsx";
import {
  shownIsBrowser,
  splitAtFocus,
  type Health,
  type Row,
  type TabItem,
} from "./model.ts";
import { ICON } from "./icons.ts";
import { termKey } from "../gws/model.ts";
import { startDrag } from "./drag.ts";
import "./sidebar.css";

/** 「+」のメニューで足せるタブ。 */
export type NewTabKind = "terminal" | "terminal.pick" | "browser";

const healthLabel = (h: Health): string => T(`health.${h}`);

interface Handlers {
  /** 帯を押した（row の帯が出しているタブへ移る） */
  onFocus: (row: Row) => void;
  /** タブの行を押した（gws は GUI のワークスペースの id、key は TabItem.key） */
  onTab?: (gws: string, key: string) => void;
  /** タブの行の ✕（ターミナルのタブもブラウザのタブも） */
  onTabClose?: (gws: string, key: string) => void;
  /** タブの行の鉛筆（名前を変える） */
  onTabRename?: (gws: string, key: string) => void;
  /** 帯のつかむ所からドラッグして落とした（before は、その帯のすぐ前の GUI のワークスペースの id。一番後ろなら null） */
  onWorkspaceMove?: (gws: string, before: string | null) => void;
  /** タブの行のつかむ所からドラッグして落とした（同じワークスペースの中だけ。before は、そのすぐ前のタブのキー。一番後ろなら null） */
  onTabMove?: (gws: string, key: string, before: string | null) => void;
  /** ヘッダーの ▾ / ▸（並びを畳む・開く） */
  onTabsFold?: (gws: string) => void;
  /** ヘッダーの「+」のメニューで選んだ。選んでいないワークスペースなら、App が先にそのワークスペースに移る */
  onAddTab?: (gws: string, kind: NewTabKind) => void;
  /** 内蔵ブラウザを使えるか。使えなければ「+」のメニューに「ブラウザ」を出さない */
  browser?: boolean;
  /** 「+」を押した（Sidebar が内側に渡す。メニューは Sidebar が出す） */
  onAddMenu?: (gws: string, x: number, y: number) => void;
  /** ツリーの行。まだ取っていなければ undefined */
  treeOf?: (target: string, id: WorkspaceId) => TreeRow[] | undefined;
  onToggle?: (target: string, id: WorkspaceId, path: string) => void;
  /** 帯の [×]（GUI のワークスペースを閉じる）。省くと出さない */
  onClose?: (gws: string) => void;
  /** 帯のメニューの「名前を変える」・帯の鉛筆のボタン（App が renaming を渡す） */
  onRenameWorkspace?: (gws: string) => void;
  /** 名前をその場で変えている帯（current は入力欄の初めの値、auto は空にしたときの名前、error は断られた理由）。無ければ undefined */
  renaming?: {
    /** GUI のワークスペースの id */
    gws: string;
    current: string;
    auto: string;
    error?: string;
  } | null;
  /** その場の入力欄で Enter を押した（空なら、つけた名前を外す） */
  onRenameSubmit?: (name: string) => void;
  /** その場の入力欄で Esc を押した（byKey が true）・フォーカスが外れた */
  onRenameCancel?: (byKey?: boolean) => void;
  /** 帯を右クリックした（Sidebar が内側に渡す。App は onRenameWorkspace を使う） */
  onBandMenu?: (gws: string, x: number, y: number) => void;
  /** ツリーのファイルの行を押した */
  onOpen?: (target: string, id: WorkspaceId, path: string) => void;
  /** プライマリの shj が出しているファイル（ツリーで強調する行の path）。無ければ undefined */
  currentOf?: (target: string, id: WorkspaceId) => string | undefined;
  /** 差分モードの CHANGES の一覧の行。差分モードでなければ undefined */
  changesOf?: (
    target: string,
    id: WorkspaceId,
  ) => { rows: ChangeRow[]; base: ChangesBase } | undefined;
  /** CHANGES の行を押した（path は shj が知らせた絶対パス） */
  onChange?: (target: string, id: WorkspaceId, path: string) => void;
  /** CHANGES で shj のキー（s・r・R・Space・:）を押した（shj に渡す） */
  onChangesKey?: (target: string, id: WorkspaceId, key: ChangesShjKey) => void;
  /** CHANGES で Tab を押した（エクスプローラに移る） */
  onChangesExplorer?: (target: string, id: WorkspaceId) => void;
  /** CHANGES で Esc・q を押した（端末に戻る） */
  onChangesLeave?: (target: string, id: WorkspaceId) => void;
  /** ファイルツリーと CHANGES の境目をつかんだ（height は画面に出ている一覧の高さ px。App がドラッグを受け持つ） */
  onChangesResize?: (e: PointerEvent, height: number) => void;
  /** 境目をダブルクリックした（高さを元に戻す） */
  onChangesResizeReset?: () => void;
  /** ツリーの行を右クリックした（Sidebar が内側に渡す。App は onTreeAction を使う） */
  onTreeMenu?: (
    target: string,
    id: WorkspaceId,
    row: TreeRow,
    x: number,
    y: number,
  ) => void;
  /** ツリーの行のメニューで項目を選んだ・行でそのキー（a・d など）を押した。省くとメニューを出さず、そのキーも使わない */
  onTreeAction?: (
    target: string,
    id: WorkspaceId,
    row: TreeRow,
    action: TreeMenuAction,
  ) => void;
}

/**
 * 左の一覧。ワークスペースの帯を 1 列に出し、帯を押すと onFocus を呼ぶ。
 * フォーカスしている帯の下に treeOf のツリーを出し、フォルダを押すと onToggle、ファイルを押すと onOpen を呼ぶ。
 *
 * 上下の固定（D3）は CSS の sticky で、要素の組み方で止まるところを決める:
 * フォーカスしている帯までは 1 つの列（ul）に流し、帯はツリーと一緒の要素の中で、フォルダの行は中身と一緒の要素の中で止まる。
 * それより後ろの帯は 1 つの要素にまとめ、一覧の下に固定する。
 */
export function Sidebar(
  props: Handlers & {
    rows: Row[];
    /** 一覧の要素（スクロールの位置を覚えて戻すのに使う） */
    ref?: (el: HTMLElement) => void;
    /** 一番下の「+ ワークスペースを作る」 */
    onNew?: () => void;
  },
): JSX.Element {
  // 帯の右クリックのメニュー。閉じ方はツリーのメニューと同じ
  const [bandMenu, setBandMenu] = createSignal<{
    gws: string;
    x: number;
    y: number;
  } | null>(null);
  const openBandMenu = props.onRenameWorkspace
    ? (gws: string, x: number, y: number) => setBandMenu({ gws, x, y })
    : undefined;
  // ヘッダーの「+」のメニュー。閉じ方は帯のメニューと同じ
  const [addMenu, setAddMenu] = createSignal<{
    gws: string;
    x: number;
    y: number;
  } | null>(null);
  const openAddMenu = props.onAddTab
    ? (gws: string, x: number, y: number) => setAddMenu({ gws, x, y })
    : undefined;
  // ツリーの行の右クリックのメニュー。出している間は、押す・Esc・スクロール・窓の切り替えで閉じる
  const [treeMenu, setTreeMenu] = createSignal<{
    target: string;
    id: WorkspaceId;
    row: TreeRow;
    x: number;
    y: number;
  } | null>(null);
  const openTreeMenu = props.onTreeAction
    ? (target: string, id: WorkspaceId, row: TreeRow, x: number, y: number) =>
        setTreeMenu({ target, id, row, x, y })
    : undefined;
  const split = createMemo(() => splitAtFocus(props.rows));
  let nav!: HTMLElement;

  // 固定されているものに data-stuck を付ける（背景と影をモックに合わせる）。
  // 上に固定するものは、sticky の位置（一覧の上端から top）にいて、親の要素の上端より下にずれていれば
  // 固定されている（中身を通り過ぎて押し出された行は sticky の位置より上にいるので外れる）。
  // 下の要素は、一覧の終わりまでスクロールしていなければ固定されている。
  // 影（data-shadow）は、上に固定されたものの一番下と、下の要素に付ける
  onMount(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      // 下に固定する要素の高さ（ツリーの行の scroll-margin-bottom。キーで動かした行が隠れないように）
      const after = nav.querySelector<HTMLElement>(":scope > .sidebar-after");
      nav.style.setProperty(
        "--sidebar-after-height",
        `${after?.offsetHeight ?? 0}px`,
      );
      // 下に固定する CHANGES の高さ（同じ理由。行の増減は MutationObserver が拾う）
      const changes = nav.querySelector<HTMLElement>(".changes");
      nav.style.setProperty(
        "--sidebar-changes-height",
        `${changes?.offsetHeight ?? 0}px`,
      );
      let last: HTMLElement | null = null;
      for (const el of nav.querySelectorAll<HTMLElement>("[data-sticky]")) {
        const bottom = el.dataset.sticky === "bottom";
        let stuck: boolean;
        if (bottom) {
          stuck = nav.scrollTop + nav.clientHeight < nav.scrollHeight - 0.5;
        } else {
          const parent = el.parentElement;
          const top = el.getBoundingClientRect().top;
          const at =
            nav.getBoundingClientRect().top +
            nav.clientTop +
            (parseFloat(getComputedStyle(el).top) || 0);
          stuck =
            parent !== null &&
            Math.abs(top - at) < 0.5 &&
            top > parent.getBoundingClientRect().top + 0.5;
          if (stuck) last = el;
        }
        el.toggleAttribute("data-stuck", stuck);
        el.toggleAttribute("data-shadow", bottom && stuck);
      }
      last?.setAttribute("data-shadow", "");
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    nav.addEventListener("scroll", schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(nav);
    // 行が増減した・フォーカスが移った。属性は data-panes-hidden だけ見る（data-stuck・data-shadow を付けても回らない。隠した・戻したときに CHANGES の高さを測り直す）
    const mutation = new MutationObserver(schedule);
    mutation.observe(nav, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-panes-hidden"],
    });
    schedule();
    onCleanup(() => {
      nav.removeEventListener("scroll", schedule);
      resize.disconnect();
      mutation.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    });
  });

  return (
    <div class="sidebar-column">
      <nav
        class="sidebar"
        aria-label={T("sidebar.workspaces")}
        ref={(el) => {
          nav = el;
          props.ref?.(el);
        }}
      >
        <ul class="bands">
          <For each={split().before}>
            {(r) => (
              <BandItem
                row={r}
                {...handlers(props, openTreeMenu, openBandMenu, openAddMenu)}
              />
            )}
          </For>
          <Show when={split().focused}>
            {(r) => (
              <BandItem
                row={r()}
                {...handlers(props, openTreeMenu, openBandMenu, openAddMenu)}
              />
            )}
          </Show>
        </ul>
        <Show when={split().after.length > 0}>
          <div class="sidebar-after" data-sticky="bottom">
            <ul class="bands">
              <For each={split().after}>
                {(r) => (
                  <BandItem
                    row={r}
                    {...handlers(
                      props,
                      openTreeMenu,
                      openBandMenu,
                      openAddMenu,
                    )}
                  />
                )}
              </For>
            </ul>
          </div>
        </Show>
      </nav>
      <Show when={bandMenu()}>
        {(m) => (
          <PopupMenu
            x={m().x}
            y={m().y}
            label={T("sidebar.workspaces")}
            items={[
              {
                label: T("sidebar.rename"),
                run: () => props.onRenameWorkspace?.(m().gws),
              },
            ]}
            onClose={() => setBandMenu(null)}
          />
        )}
      </Show>
      <Show when={addMenu()}>
        {(m) => (
          <PopupMenu
            x={m().x}
            y={m().y}
            label={T("sidebar.addTab")}
            items={[
              {
                label: T("sidebar.addTerminal"),
                run: () => props.onAddTab?.(m().gws, "terminal"),
              },
              {
                label: T("sidebar.addTerminalPick"),
                run: () => props.onAddTab?.(m().gws, "terminal.pick"),
              },
              ...(props.browser
                ? [
                    {
                      label: T("sidebar.addBrowser"),
                      run: () => props.onAddTab?.(m().gws, "browser"),
                    },
                  ]
                : []),
            ]}
            onClose={() => setAddMenu(null)}
          />
        )}
      </Show>
      <Show when={treeMenu()}>
        {(m) => (
          <TreeMenu
            x={m().x}
            y={m().y}
            label={m().row.name}
            items={menuItems(m().row)}
            onChoose={(a) =>
              props.onTreeAction?.(m().target, m().id, m().row, a)
            }
            onClose={() => setTreeMenu(null)}
          />
        )}
      </Show>
      <div class="sidebar-foot">
        <button
          type="button"
          class="new-workspace"
          onClick={() => props.onNew?.()}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          {T("sidebar.newWorkspace")}
        </button>
      </div>
    </div>
  );
}

/** 子に渡す処理だけを取り出す（getter にして、props の追跡を保つ）。 */
function handlers(
  props: Handlers,
  onTreeMenu: Handlers["onTreeMenu"] = props.onTreeMenu,
  onBandMenu: Handlers["onBandMenu"] = props.onBandMenu,
  onAddMenu: Handlers["onAddMenu"] = props.onAddMenu,
): Handlers {
  return {
    onTreeMenu,
    onBandMenu,
    onAddMenu,
    get browser() {
      return props.browser;
    },
    get onTabRename() {
      return props.onTabRename;
    },
    get onWorkspaceMove() {
      return props.onWorkspaceMove;
    },
    get onTabMove() {
      return props.onTabMove;
    },
    get onFocus() {
      return props.onFocus;
    },
    get onTab() {
      return props.onTab;
    },
    get onTabClose() {
      return props.onTabClose;
    },
    get onTabsFold() {
      return props.onTabsFold;
    },
    get treeOf() {
      return props.treeOf;
    },
    get onToggle() {
      return props.onToggle;
    },
    get onClose() {
      return props.onClose;
    },
    get onOpen() {
      return props.onOpen;
    },
    get currentOf() {
      return props.currentOf;
    },
    get changesOf() {
      return props.changesOf;
    },
    get onChange() {
      return props.onChange;
    },
    get onChangesKey() {
      return props.onChangesKey;
    },
    get onChangesExplorer() {
      return props.onChangesExplorer;
    },
    get onChangesLeave() {
      return props.onChangesLeave;
    },
    get onChangesResize() {
      return props.onChangesResize;
    },
    get onChangesResizeReset() {
      return props.onChangesResizeReset;
    },
    get onTreeAction() {
      return props.onTreeAction;
    },
    get renaming() {
      return props.renaming;
    },
    get onRenameSubmit() {
      return props.onRenameSubmit;
    },
    get onRenameCancel() {
      return props.onRenameCancel;
    },
    get onRenameWorkspace() {
      return props.onRenameWorkspace;
    },
  };
}

/**
 * 切れているときだけ、その部分の全文を title に出す。切れていなければ title を外し、帯のフルパス（親の title）を出す。
 * 切れているかは、マウスが乗った時に調べる（幅はサイドバーを動かすと変わるので、描いた時には決めない）。
 */
function titleIfClipped(full: string): JSX.HTMLAttributes<HTMLSpanElement> {
  return {
    onMouseEnter: (e) => {
      const el = e.currentTarget;
      if (el.scrollWidth > el.clientWidth) el.title = full;
      else el.removeAttribute("title");
    },
  };
}

/** 絵の字（Nerd Fonts）。読み上げには出さない。 */
function Nf(props: { c: string; class?: string }): JSX.Element {
  return (
    <span class={`nf ${props.class ?? ""}`} aria-hidden="true">
      {props.c}
    </span>
  );
}

/**
 * ヘッダーとタブの行の左端の、つかむ所（縦の点 3 つ）。ドラッグ（drag.ts）はここからだけ始める。
 * 行のボタンはここに無いので、行の押下とは取り合わない。スクロールも、ここを押したときは始めさせない（CSS の touch-action）。
 * onGrab を渡さなければ、場所と見た目だけ（動かせない）。ドラッグは場所を指す操作なので、読み上げには出さない（帯にはキー、リーダーの w J / w K がある。タブの行にはキーが無い）。
 */
function Grip(props: { onGrab?: (e: PointerEvent) => void }): JSX.Element {
  return (
    <span
      class="grip"
      data-grab={props.onGrab ? "" : undefined}
      aria-hidden="true"
      onPointerDown={(e) => props.onGrab?.(e)}
    />
  );
}

/** 帯のつかむ所を押した。一覧の帯を、ヘッダーの真ん中で比べて、落とした先の帯の前へ動かす。 */
function grabBand(
  e: PointerEvent,
  row: Row,
  onMove: NonNullable<Handlers["onWorkspaceMove"]>,
) {
  const scroller = (e.currentTarget as HTMLElement).closest<HTMLElement>(
    "nav.sidebar",
  );
  if (!scroller) return;
  startDrag(e, {
    scroller,
    self: row.gws,
    rows: () =>
      bandElements(scroller).map((el) => ({
        key: el.dataset.gws!,
        el,
        ref: el.querySelector<HTMLElement>(".band-slot") ?? el,
      })),
    onDrop: (before) => onMove(row.gws, before),
  });
}

/** タブの行のつかむ所を押した。同じ帯の中のタブの行だけを相手にする（別の帯には落とせない）。 */
function grabTab(
  e: PointerEvent,
  gws: string,
  key: string,
  onMove: NonNullable<Handlers["onTabMove"]>,
) {
  const scroller = (e.currentTarget as HTMLElement).closest<HTMLElement>(
    "nav.sidebar",
  );
  if (!scroller) return;
  startDrag(e, {
    scroller,
    self: key,
    confine: true,
    // 帯もタブの行も、描き直されて作り直されることがあるので、そのたびに一覧から引き直す
    rows: () => {
      const band = bandElements(scroller).find((el) => el.dataset.gws === gws);
      return [
        ...(band?.querySelectorAll<HTMLElement>(
          ":scope > ul.tab-rows > li.tab-row[data-key]",
        ) ?? []),
      ].map((el) => ({
        key: el.dataset.key!,
        el,
        ref: el.querySelector<HTMLElement>(".tab-line") ?? el,
      }));
    },
    onDrop: (before) => onMove(gws, key, before),
  });
}

/** 一覧にいまある帯（li.band-item）。上から順。 */
const bandElements = (scroller: HTMLElement): HTMLElement[] => [
  ...scroller.querySelectorAll<HTMLElement>("li.band-item[data-gws]"),
];

/**
 * 名前をその場で変える入力欄（Enter で onRenameSubmit、Esc・フォーカスが外れたら onRenameCancel）。
 * 入力欄はボタンの中に置けないので、名前を変えている間は、フォーカスを移すボタンの所がこの div になる。
 */
function BandRenameInput(
  props: Handlers & { edit: NonNullable<Handlers["renaming"]> },
): JSX.Element {
  return (
    <div class="band-main">
      <input
        class="band-rename"
        type="text"
        aria-label={T("sidebar.nameLabel")}
        aria-invalid={props.edit.error ? "true" : undefined}
        placeholder={T("sidebar.namePlaceholder", { auto: props.edit.auto })}
        value={props.edit.current}
        onKeyDown={(e) => {
          const a = renameKeyAction(e);
          if (!a) return;
          e.preventDefault();
          e.stopPropagation();
          if (a === "submit") props.onRenameSubmit?.(e.currentTarget.value);
          else props.onRenameCancel?.(true);
        }}
        onBlur={() => {
          // ほかのアプリに切り替えただけ（窓が外れた）では、打ちかけの名前を消さない
          if (document.hasFocus()) props.onRenameCancel?.();
        }}
        ref={(el) =>
          // リーダーの後でターミナルにフォーカスが戻るのと競らないよう、1 拍置いて取る
          setTimeout(() => {
            el.focus();
            el.select();
          })
        }
      />
    </div>
  );
}

/**
 * 帯のヘッダー（つかむ所・畳む・名前（その場の入力欄）・「+」・鉛筆・✕）。フォーカスしていれば上に固定する。
 * ヘッダーは行にして、ボタンを並べる。名前を変えている間は、フォーカスを移すボタンの所が入力欄の div になる（ボタンの中に入力欄もボタンも置けない）。
 */
function BandHeader(
  props: Handlers & { row: Row; editing: Handlers["renaming"] },
): JSX.Element {
  const b = () => props.row.band;
  const tabs = () => props.row.tabs;
  const editing = () => props.editing ?? undefined;
  return (
    <div class="band-slot" data-sticky={b().focused ? "top" : undefined}>
      <div
        class="band"
        aria-current={b().focused ? "true" : undefined}
        title={b().root || undefined}
        onContextMenu={(e) => {
          if (!props.onBandMenu) return;
          e.preventDefault();
          props.onBandMenu(props.row.gws, e.clientX, e.clientY);
        }}
      >
        <Grip
          onGrab={
            props.onWorkspaceMove
              ? (e) => grabBand(e, props.row, props.onWorkspaceMove!)
              : undefined
          }
        />
        <button
          type="button"
          class="band-btn band-fold"
          aria-expanded={!tabs().folded}
          aria-label={T("sidebar.foldTabs")}
          title={T("sidebar.foldTabs")}
          onClick={() => props.onTabsFold?.(props.row.gws)}
        >
          <Nf c={tabs().folded ? ICON.folded : ICON.open} />
        </button>
        <Show
          when={editing()}
          fallback={
            <button
              type="button"
              class="band-main"
              onClick={() => props.onFocus(props.row)}
            >
              <span class="band-title">{b().title}</span>
            </button>
          }
        >
          {(r) => <BandRenameInput {...props} edit={r()} />}
        </Show>
        <Show when={props.onAddMenu}>
          <button
            type="button"
            class="band-btn band-add"
            aria-haspopup="menu"
            aria-label={T("sidebar.addTabTo", { title: b().title })}
            title={T("sidebar.addTab")}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              props.onAddMenu?.(props.row.gws, r.left, r.bottom);
            }}
          >
            <Nf c={ICON.plus} />
          </button>
        </Show>
        <button
          type="button"
          class="band-btn band-close band-edit"
          data-off={props.onRenameWorkspace && !editing() ? undefined : ""}
          aria-label={T("sidebar.renameBand", { title: b().title })}
          title={T("sidebar.rename")}
          onClick={() => props.onRenameWorkspace?.(props.row.gws)}
        >
          <Nf c={ICON.pencil} />
        </button>
        <button
          type="button"
          class="band-btn band-close"
          data-off={props.onClose ? undefined : ""}
          aria-label={T("sidebar.closeBand", { title: b().title })}
          title={T("sidebar.closeWorkspace")}
          onClick={() => props.onClose?.(props.row.gws)}
        >
          <Nf c={ICON.close} />
        </button>
      </div>
    </div>
  );
}

/**
 * 今出しているターミナルのタブの下に開く、ファイルツリーと CHANGES（プライマリで shj が動いている、フォーカスしているワークスペースだけ）。
 * タブの並びを開いているときはそのタブの行の中、畳んでいるときはヘッダーのすぐ下に出す（畳んでもツリーは消えない）。
 */
function RowPanes(props: Handlers & { row: Row }): JSX.Element {
  const b = () => props.row.band;
  // ブラウザのタブを出している間は、外さずに見えなくして、状態を保つ（#268）
  const hidden = () => shownIsBrowser(props.row.tabs);
  return (
    <div
      style={{ display: hidden() ? "none" : "contents" }}
      data-panes-hidden={hidden() ? "" : undefined}
    >
      <Show
        when={
          b().focused &&
          b().showTree &&
          props.treeOf?.(props.row.target, b().id)
        }
      >
        {(rows) => (
          <TreeView
            rows={rows()}
            label={T("sidebar.files", { title: b().title })}
            onToggle={(p) => props.onToggle?.(props.row.target, b().id, p)}
            onOpen={(p) => props.onOpen?.(props.row.target, b().id, p)}
            current={props.currentOf?.(props.row.target, b().id)}
            onMenu={
              props.onTreeMenu
                ? (row, x, y) =>
                    props.onTreeMenu?.(props.row.target, b().id, row, x, y)
                : undefined
            }
            onAction={
              props.onTreeAction
                ? (row, a) =>
                    props.onTreeAction?.(props.row.target, b().id, row, a)
                : undefined
            }
          />
        )}
      </Show>
      <Show
        when={
          b().focused &&
          b().showTree &&
          props.changesOf?.(props.row.target, b().id)
        }
      >
        {(c) => (
          <ChangesView
            rows={c().rows}
            base={c().base}
            label={T("sidebar.changes", { title: b().title })}
            onSelect={(p) => props.onChange?.(props.row.target, b().id, p)}
            onShjKey={(k) => props.onChangesKey?.(props.row.target, b().id, k)}
            onExplorer={() =>
              props.onChangesExplorer?.(props.row.target, b().id)
            }
            onLeave={() => props.onChangesLeave?.(props.row.target, b().id)}
            onResizeStart={props.onChangesResize}
            onResizeReset={props.onChangesResizeReset}
          />
        )}
      </Show>
    </div>
  );
}

/** 帯 1 つ（ヘッダーとコンテンツ）。 */
function BandItem(props: Handlers & { row: Row }): JSX.Element {
  const b = () => props.row.band;
  const tabs = () => props.row.tabs;
  // この帯の名前をその場で変えているときだけ、その内容
  const editing = () => {
    const r = props.renaming;
    return r && r.gws === props.row.gws ? r : undefined;
  };
  // ファイルツリーと CHANGES を開くタブの行（今出しているターミナルのタブ）
  const repKey = () => termKey(props.row.target, b().id);
  return (
    <li
      class="band-item"
      data-gws={props.row.gws}
      style={{ "--machine-color": props.row.color }}
      data-focused={b().focused ? "" : undefined}
      data-health={props.row.health}
    >
      <BandHeader {...props} editing={editing()} />
      {/* 断られた理由は、帯の下に流れで置く（下のツリーが押し下がる）。重ねると、箱の overflow: clip（#170）で切り取られる */}
      <Show when={editing()?.error}>
        {(e) => (
          <div class="band-rename-error" role="alert">
            {e()}
          </div>
        )}
      </Show>
      <Show when={!tabs().folded} fallback={<RowPanes {...props} />}>
        <ul
          class="tab-rows"
          aria-label={T("sidebar.tabsOf", { title: b().title })}
        >
          <For each={tabs().items}>
            {(t) => (
              <TabRow
                t={t}
                shown={tabs().shown === t.key}
                current={tabs().shown === t.key && tabs().focused}
                onTab={() => props.onTab?.(props.row.gws, t.key)}
                onClose={() => props.onTabClose?.(props.row.gws, t.key)}
                onRename={
                  props.onTabRename
                    ? () => props.onTabRename?.(props.row.gws, t.key)
                    : undefined
                }
                onGrab={
                  props.onTabMove
                    ? (e) => grabTab(e, props.row.gws, t.key, props.onTabMove!)
                    : undefined
                }
              >
                <Show when={t.key === repKey()}>
                  <RowPanes {...props} />
                </Show>
              </TabRow>
            )}
          </For>
        </ul>
      </Show>
    </li>
  );
}

/**
 * タブの行 1 つ（ターミナルのタブもブラウザのタブも）。
 * ターミナルのタブは 1 行目にアイコン・名前・マシンの札、2 行目にフォルダ、3 行目に git。ブラウザのタブは 1 行目にアイコン・名前、2 行目に URL。
 * 鉛筆と ✕ は、1 行目の右に場所を空けておき、出ているときだけ見せる（選んでも行の高さが変わらないように）。
 * children は、行のすぐ下に開くもの（ファイルツリーと CHANGES）。
 */
function TabRow(props: {
  t: TabItem;
  /** そのワークスペースで出しているタブか */
  shown: boolean;
  /** 出しているタブで、そのワークスペースにフォーカスしているか（強く光らせる） */
  current: boolean;
  onTab: () => void;
  onClose: () => void;
  onRename?: () => void;
  /** つかむ所を押した（ドラッグで並べ替える）。省くと動かせない */
  onGrab?: (e: PointerEvent) => void;
  children?: JSX.Element;
}): JSX.Element {
  const t = () => props.t;
  return (
    <li
      class="tab-row"
      data-key={t().key}
      data-kind={t().kind}
      data-health={t().health}
      data-shown={props.shown ? "" : undefined}
      data-current={props.current ? "" : undefined}
    >
      <div class="tab-line">
        <Grip onGrab={props.onGrab} />
        <button
          type="button"
          class="tab-main"
          title={t().tip || undefined}
          aria-current={props.current ? "page" : undefined}
          onClick={() => props.onTab()}
        >
          <span class="tab-l1">
            <Show
              when={t().favicon}
              fallback={
                <Nf
                  class="tab-icon"
                  c={t().kind === "term" ? ICON.terminal : ICON.globe}
                />
              }
            >
              {(src) => <img class="tab-icon tab-favicon" src={src()} alt="" />}
            </Show>
            <Show when={t().incognito}>
              <span class="tab-incognito">{T("sidebar.incognito")}</span>
            </Show>
            <span class="tab-title">{t().title}</span>
            <Show when={t().machine}>
              {(m) => (
                <span
                  class="tab-machine"
                  style={{ color: m().color }}
                  title={T("sidebar.machineHealth", {
                    machine: m().name,
                    health: healthLabel(m().health),
                  })}
                >
                  <Nf c={ICON.machine} />
                  <span
                    class="health"
                    data-health={m().health}
                    role="img"
                    aria-label={healthLabel(m().health)}
                  />
                  <span class="tab-machine-name">{m().name}</span>
                </span>
              )}
            </Show>
          </span>
          <Show when={t().path}>
            <span class="tab-l2">
              <Nf c={t().kind === "term" ? ICON.folder : ICON.link} />
              <span class="tab-text" {...titleIfClipped(t().path)}>
                {t().path}
              </span>
            </span>
          </Show>
          <Show when={t().git}>
            <span class="tab-l3">
              <Nf c={ICON.git} />
              <span class="tab-text" {...titleIfClipped(t().git)}>
                {t().git}
              </span>
            </span>
          </Show>
        </button>
        <div class="tab-actions">
          <button
            type="button"
            class="band-btn band-close tab-edit"
            data-off={props.onRename ? undefined : ""}
            aria-label={T("sidebar.renameTabLabel", { title: t().title })}
            title={T("sidebar.renameTab")}
            onClick={() => props.onRename?.()}
          >
            <Nf c={ICON.pencil} />
          </button>
          <button
            type="button"
            class="band-btn band-close tab-close"
            data-off={t().closable ? undefined : ""}
            aria-label={T(
              t().incognito
                ? "sidebar.closeTabLabelIncognito"
                : "sidebar.closeTabLabel",
              { title: t().title },
            )}
            title={T("sidebar.closeTab")}
            onClick={() => props.onClose()}
          >
            <Nf c={ICON.close} />
          </button>
        </div>
      </div>
      {props.children}
    </li>
  );
}

/**
 * 右クリックのメニュー（マシンの見出し・ワークスペースの帯）。開いたら最初の項目にキーを向ける。
 * 項目を選ぶ・メニューの外を押す・Esc・スクロール・窓が見えなくなる、のどれかで閉じる。
 * note があれば、項目の下に理由などを出す。
 */
function PopupMenu(props: {
  x: number;
  y: number;
  /** メニューの名前（読み上げ用） */
  label: string;
  items: { label: string; run: () => void; disabled?: boolean }[];
  note?: string;
  onClose: () => void;
}): JSX.Element {
  let el!: HTMLDivElement;
  onMount(() => {
    const close = () => props.onClose();
    const down = (e: Event) => {
      if (!el.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [
          ...el.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)"),
        ];
        const i = items.indexOf(document.activeElement as HTMLElement);
        const step = e.key === "ArrowDown" ? 1 : -1;
        items[(i + step + items.length) % items.length]?.focus();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("contextmenu", down, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    // 画面の端ではみ出す分だけ、左・上にずらす
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(0, Math.min(props.x, window.innerWidth - r.width))}px`;
    el.style.top = `${Math.max(0, Math.min(props.y, window.innerHeight - r.height))}px`;
    el.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus();
    onCleanup(() => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("contextmenu", down, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    });
  });
  const choose = (run: () => void) => () => {
    run(); // 親の <Show> の値は onClose で消えるので、先に run
    props.onClose();
  };
  return (
    <div
      class="machine-menu"
      role="menu"
      aria-label={props.label}
      ref={el}
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
    >
      <For each={props.items}>
        {(it) => (
          <button
            type="button"
            role="menuitem"
            class="machine-menu-item"
            disabled={it.disabled}
            onClick={choose(it.run)}
          >
            {it.label}
          </button>
        )}
      </For>
      <Show when={props.note}>
        {(n) => <p class="machine-menu-note">{n()}</p>}
      </Show>
    </div>
  );
}
