// 左の一覧（D1）：GUI のワークスペース（gws/model.ts。#231）の帯を 1 列に並べる（#201）。マシンの見出しは無い。帯を押すとフォーカスを移す。
// 並び順はユーザーが並べた順（リーダーの w J / w K で動かす）。マシンをまたいで 1 列になる。
// 各帯には、そのワークスペースが今出しているターミナルのタブのマシンの名前と接続の状態（丸）を小さく出す。つながっていないマシンのタブは、最後に分かった名前で薄く出す。
// フォーカスしているワークスペースの帯の下にはツリーを出す（プライマリで shj が動いているときだけ。動いていなければ帯だけ）（D2、描くのは tree/TreeView.tsx）。
// スクロールしても、上にフォーカスしている帯と親フォルダを、下にそれより後ろの帯を固定する（D3）。
// マシンごとの色（D4）は帯の --machine-color に入れ、左端の線とアイコンに使う。
// 帯の右の [×] は、押すと onClose を呼ぶ（ワークスペースを閉じる。中のターミナルのタブも閉じる。確認は App が窓で出す）。
// 一覧の一番下の「+ ワークスペースを作る」は、押すと onNew を呼ぶ（どのマシンに作るかは App が窓で選ばせる）。
// マシンの操作（足す・名前を変える・外す・切る・つなぎ直す）は、サイドバーではなくマシンのダイアログ（リーダーの m）にある。
// ワークスペースの帯の右クリックのメニューの「名前を変える」と、帯の鉛筆のボタンは、onRenameWorkspace を呼ぶ。
// App が renaming を渡すと、その帯の 1 行目の名前がその場で入力欄になる（Enter で onRenameSubmit、Esc・フォーカスが外れたら onRenameCancel）。
// 帯の下には、ワークスペースのタブ（ターミナルのタブも内蔵ブラウザ（#202）のタブも、開いた順に 1 つの並びで）を並べる（row.tabs。タブが 1 つだけなら出さない）。タブの行を押すと onTab、ブラウザのタブの × で onTabClose、
// 「タブ」の見出しで onTabsFold（並びを畳む・開く）。タブを出していれば、その行を光らせる。
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
  splitAtFocus,
  type Band,
  type BandTabs,
  type Health,
  type Row,
  DIR_SEP,
  shaText,
} from "./model.ts";
import "./sidebar.css";

const healthLabel = (h: Health): string => T(`health.${h}`);

interface Handlers {
  onFocus: (target: string, id: WorkspaceId) => void;
  /** タブの行を押した（gws は GUI のワークスペースの id、key は TabItem.key） */
  onTab?: (gws: string, key: string) => void;
  /** ブラウザのタブの行の × */
  onTabClose?: (tab: string) => void;
  /** 「タブ」の見出し（並びを畳む・開く） */
  onTabsFold?: (gws: string) => void;
  /** ツリーの行。まだ取っていなければ undefined */
  treeOf?: (target: string, id: WorkspaceId) => TreeRow[] | undefined;
  onToggle?: (target: string, id: WorkspaceId, path: string) => void;
  /** 帯の [×]（GUI のワークスペースを閉じる）。省くと出さない */
  onClose?: (gws: string) => void;
  /** 帯のメニューの「名前を変える」・帯の鉛筆のボタン（App が renaming を渡す） */
  onRenameWorkspace?: (target: string, id: WorkspaceId) => void;
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
  onBandMenu?: (target: string, id: WorkspaceId, x: number, y: number) => void;
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
    target: string;
    id: WorkspaceId;
    x: number;
    y: number;
  } | null>(null);
  const openBandMenu = props.onRenameWorkspace
    ? (target: string, id: WorkspaceId, x: number, y: number) =>
        setBandMenu({ target, id, x, y })
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
    // 行が増減した・フォーカスが移った（属性は見ないので、data-stuck を付けても回らない）
    const mutation = new MutationObserver(schedule);
    mutation.observe(nav, { childList: true, subtree: true });
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
                {...handlers(props, openTreeMenu, openBandMenu)}
              />
            )}
          </For>
          <Show when={split().focused}>
            {(r) => (
              <BandItem
                row={r()}
                {...handlers(props, openTreeMenu, openBandMenu)}
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
                    {...handlers(props, openTreeMenu, openBandMenu)}
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
                run: () => props.onRenameWorkspace?.(m().target, m().id),
              },
            ]}
            onClose={() => setBandMenu(null)}
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
): Handlers {
  return {
    onTreeMenu,
    onBandMenu,
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

/**
 * 帯の 2 行目。「ディレクトリ名 · ブランチ (sha)」。狭いときは、先にディレクトリ名、次にブランチ名を「…」で切る（sha は切らない）。
 * 切る順は sidebar.css の flex-shrink で決める。
 */
function BandDetail(props: { band: Band }): JSX.Element {
  const b = () => props.band;
  return (
    <span class="band-detail">
      <Show when={b().dir}>
        <span class="band-dir" {...titleIfClipped(b().dir)}>
          {b().dir}
        </span>
        <span class="band-sep" aria-hidden="true">
          {DIR_SEP}
        </span>
      </Show>
      <Show when={b().branch}>
        <span class="band-branch" {...titleIfClipped(b().branch)}>
          {b().branch}
        </span>
      </Show>
      <Show when={b().sha}>
        <span class="band-sha">{shaText(b().sha)}</span>
      </Show>
      <Show when={b().note}>
        <span class="band-note">{b().note}</span>
      </Show>
      <Show when={b().num}>
        <span class="band-note">{b().num}</span>
      </Show>
    </span>
  );
}

/** 帯 1 つ。フォーカスしていれば帯を上に固定し、下にツリーを出す。 */
function BandItem(props: Handlers & { row: Row }): JSX.Element {
  const b = () => props.row.band;
  // この帯の名前をその場で変えているときだけ、その内容
  const editing = () => {
    const r = props.renaming;
    return r && r.gws === props.row.gws ? r : undefined;
  };
  return (
    <li
      class="band-item"
      style={{ "--machine-color": props.row.color }}
      data-focused={b().focused ? "" : undefined}
      data-health={props.row.health}
    >
      {/* カードの中は行にして、ボタン（フォーカスを移す・名前を変える・閉じる）を並べる。名前を変えている間は、フォーカスを移すボタンの所が入力欄の div になる（ボタンの中に入力欄もボタンも置けない） */}
      <div class="band-slot" data-sticky={b().focused ? "top" : undefined}>
        <div
          class="band"
          aria-current={b().focused ? "true" : undefined}
          title={b().root || undefined}
          onContextMenu={(e) => {
            if (!props.onBandMenu) return;
            e.preventDefault();
            props.onBandMenu(props.row.target, b().id, e.clientX, e.clientY);
          }}
        >
          <Show
            when={editing()}
            fallback={
              <button
                type="button"
                class="band-main"
                onClick={() => props.onFocus(props.row.target, b().id)}
              >
                <span class="band-head">
                  <span
                    class="band-title"
                    classList={{ path: b().path, unset: b().unset }}
                  >
                    {b().title}
                  </span>
                  <span
                    class="band-machine"
                    title={T("sidebar.machineHealth", {
                      machine: props.row.machine,
                      health: healthLabel(props.row.health),
                    })}
                  >
                    <span
                      class="health"
                      data-health={props.row.health}
                      role="img"
                      aria-label={healthLabel(props.row.health)}
                    />
                    <span class="band-machine-name">{props.row.machine}</span>
                  </span>
                </span>
                <BandDetail band={b()} />
              </button>
            }
          >
            {(r) => (
              // 入力欄はボタンの中に置けないので、名前を変えている間は div にする
              <div class="band-main">
                <input
                  class="band-rename"
                  type="text"
                  aria-label={T("sidebar.nameLabel")}
                  aria-invalid={r().error ? "true" : undefined}
                  placeholder={T("sidebar.namePlaceholder", { auto: r().auto })}
                  value={r().current}
                  onKeyDown={(e) => {
                    const a = renameKeyAction(e);
                    if (!a) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (a === "submit")
                      props.onRenameSubmit?.(e.currentTarget.value);
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
            )}
          </Show>
          <Show when={props.onRenameWorkspace && !editing()}>
            <button
              type="button"
              class="band-close band-edit"
              aria-label={T("sidebar.renameBand", { title: b().title })}
              title={T("sidebar.rename")}
              onClick={() =>
                props.onRenameWorkspace?.(props.row.target, b().id)
              }
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M4 20l1-4L16.5 4.5a2 2 0 0 1 3 0a2 2 0 0 1 0 3L8 19l-4 1zM14 7l3 3" />
              </svg>
            </button>
          </Show>
          <Show when={props.onClose}>
            <button
              type="button"
              class="band-close"
              aria-label={T("sidebar.closeBand", { title: b().title })}
              title={T("sidebar.closeWorkspace")}
              onClick={() => props.onClose?.(props.row.gws)}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </Show>
        </div>
      </div>
      {/* 断られた理由は、帯の下に流れで置く（下のツリーが押し下がる）。重ねると、箱の overflow: clip（#170）で切り取られる */}
      <Show when={editing()?.error}>
        {(e) => (
          <div class="band-rename-error" role="alert">
            {e()}
          </div>
        )}
      </Show>
      <Show when={props.row.tabs}>
        {(br) => (
          <BandTabRows
            title={b().title}
            tabs={br()}
            onTab={(k) => props.onTab?.(props.row.gws, k)}
            onClose={(t) => props.onTabClose?.(t)}
            onFold={() => props.onTabsFold?.(props.row.gws)}
          />
        )}
      </Show>
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
    </li>
  );
}

/** 帯の下の、タブの並び（ターミナルのタブもブラウザのタブも。#231）。 */
function BandTabRows(props: {
  /** ワークスペースの名前（読み上げ用） */
  title: string;
  tabs: BandTabs;
  onTab: (key: string) => void;
  onClose: (tab: string) => void;
  onFold: () => void;
}): JSX.Element {
  return (
    <div class="band-tabs">
      <button
        type="button"
        class="band-tabs-fold"
        aria-expanded={!props.tabs.folded}
        title={T("sidebar.foldTabs")}
        onClick={() => props.onFold()}
      >
        <span class="band-tabs-chevron" aria-hidden="true">
          {props.tabs.folded ? "▸" : "▾"}
        </span>
        {T("sidebar.tabsCount", { n: props.tabs.items.length })}
      </button>
      <Show when={!props.tabs.folded}>
        <ul
          class="tab-rows"
          aria-label={T("sidebar.tabsOf", { title: props.title })}
        >
          <For each={props.tabs.items}>
            {(t) => (
              <li
                class="tab-row"
                data-kind={t.kind}
                data-health={t.health}
                data-shown={props.tabs.shown === t.key ? "" : undefined}
                data-current={
                  props.tabs.shown === t.key && props.tabs.focused
                    ? ""
                    : undefined
                }
              >
                <button
                  type="button"
                  class="tab-main"
                  title={t.tip || undefined}
                  aria-current={
                    props.tabs.shown === t.key && props.tabs.focused
                      ? "page"
                      : undefined
                  }
                  onClick={() => props.onTab(t.key)}
                >
                  <Show when={t.kind === "term"}>
                    <span
                      class="health tab-health"
                      data-health={t.health}
                      role="img"
                      aria-label={healthLabel(t.health ?? "down")}
                    />
                  </Show>
                  <Show when={t.incognito}>
                    <span class="tab-incognito">{T("sidebar.incognito")}</span>
                  </Show>
                  <span class="tab-title">{t.title}</span>
                  <Show when={t.sub}>
                    <span class="tab-host">{t.sub}</span>
                  </Show>
                </button>
                <Show when={t.closable}>
                  <button
                    type="button"
                    class="band-close tab-close"
                    aria-label={T(
                      t.incognito
                        ? "sidebar.closeTabLabelIncognito"
                        : "sidebar.closeTabLabel",
                      { title: t.title },
                    )}
                    title={T("sidebar.closeTab")}
                    onClick={() => t.tab !== undefined && props.onClose(t.tab)}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
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
