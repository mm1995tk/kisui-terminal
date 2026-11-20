// 左の一覧（D1）：GUI のワークスペース（features/workspaces/model.ts。#231）のうち、フォーカスしているものだけを出す（#283）。マシンの見出しは無い。
// ほかのワークスペースへ移るのは、ヘッダーの名前を押して開く切り替えのポップアップ（リーダーの w。ui/main-window/workspaces/WorkspaceSwitcher.tsx）。並べ替えもそこでする。
// 一覧の並び順はユーザーが並べた順。ヘッダーの名前の右に切り替えの印（⇄）を出す。
// 帯には、そのワークスペースが今出しているターミナルのタブのマシンの名前と接続の状態（丸）を小さく出す。つながっていないマシンのタブは、最後に分かった名前で薄く出す。
// フォーカスしている帯の下にはツリーを出す（プライマリで shj が動いているときだけ。動いていなければ帯だけ）（D2、描くのは ui/main-window/sidebar/file-tree/TreeView.tsx）。
// スクロールしても、上にフォーカスしている帯と親フォルダを固定する（D3）。
// マシンごとの色（D4）は帯の --machine-color に入れ、タブの行のマシンの札とフォーカスの輪郭に使う。
// ヘッダーの [×] は、押すと onClose を呼ぶ（ワークスペースを閉じる。中のターミナルのタブも閉じる。確認の窓は ui/main-window/workspaces/WorkspaceDialogs.tsx が出す）。
// フォーカスしているワークスペースが無いとき（1 つも無いときなど）は、切り替えのポップアップを開くボタンと「+ ワークスペースを作る」（onNew。どのマシンに作るかは features/workspaces/controller.ts が決め、窓で選ばせる）だけを出す。
// マシンの操作（足す・名前を変える・外す・切る・つなぎ直す）は、サイドバーではなくマシンのダイアログ（リーダーの m）にある。
// ワークスペースのヘッダーの右クリックのメニューの「名前を変える」と、ヘッダーの鉛筆のボタンは、onRenameWorkspace を呼ぶ。
// 呼ぶ側（ui/main-window/page.tsx）が renaming を渡すと、ヘッダーの名前がその場で入力欄になる（Enter で onRenameSubmit、Esc・フォーカスが外れたら onRenameCancel）。
// 帯はヘッダー（名前と切り替え・「+」・鉛筆・✕）とコンテンツ（タブの行。ターミナルのタブも内蔵ブラウザ（#202）のタブも、開いた順に 1 つの並びで）に分ける（#234）。
// タブの行を押すと onTab、行の ✕ で onTabClose、鉛筆で onTabRename。タブを出していれば、その行を光らせる。
// ヘッダーの「+」は小さなメニューを出し、選んだものを onAddTab に渡す（ターミナル・ターミナル（マシンを選ぶ）・ブラウザ）。
// プライマリで shj が動いているとき（ファイルツリーを出すとき）は、ヘッダーの下を「タブ」「ファイルツリー」「CHANGES」の 3 段に分け、段ごとにその中だけでスクロールする（#284）。
// タブの段の高さには上限（サイドバーの高さの %。設定・境目のドラッグ・リサイズモードで変える）があり、タブが少なければ中身の高さまで縮める。動いていなければ、段に分けず、タブがサイドバーの高さを全部使う。
// タブを足した・出しているタブが替わったら、その行が見える所までタブの段をスクロールする。
// ブラウザのタブを出している間は、ファイルツリーと CHANGES を見えなくし、タブの段に高さの上限を付けない（外さないので、開いているフォルダ・選んでいる行・境目の位置は残る。#268）。
// 選んでも帯・行の位置と高さが変わらないよう、鉛筆・✕・つかむ所は出ていないときも場所を空けておく（sidebar.css）。
// 組み立ては model.ts、並び順は order.ts、色の決め方は colors.ts、見た目は sidebar.css。
import { T } from "../../../i18n/index.ts";
import {
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";

import { menuItems } from "../../../features/file-tree/menu.ts";
import type { TreeRow } from "../../../features/file-tree/model.ts";
import { focusedRow, type Row } from "../../../features/workspaces/rows.ts";
import type { NewTabKind } from "../../../features/workspaces/tabs/controller.ts";
import type { WorkspaceId } from "../../../infrastructure/rpc/protocol.ts";
// CSS を持つ部品の import は、この順（帯の中の CHANGES・ツリー → sidebar.css）を変えない（理由は ../page.tsx）
import { BandItem } from "./workspaces/BandItem.tsx";
import { EmptyHeader } from "./workspaces/BandHeader.tsx";
import { TreeMenu } from "./file-tree/TreeMenu.tsx";
import { dbTreeTabOf, handlers, type Handlers } from "./handlers.ts";
import { PopupMenu } from "./PopupMenu.tsx";
import "./sidebar.css";

export type { NewTabKind };

/**
 * 左の一覧。フォーカスしているワークスペースの帯だけを出し、帯の名前を押すと onSwitch を呼ぶ。
 * 帯の下に treeOf のツリーを出し、フォルダを押すと onToggle、ファイルを押すと onOpen を呼ぶ。
 *
 * 上への固定（D3）は CSS の sticky で、要素の組み方で止まるところを決める:
 * 帯のヘッダーはツリーと一緒の要素の中で、フォルダの行は中身と一緒の要素の中で止まる。
 */
export function Sidebar(
  props: Handlers & {
    rows: Row[];
    /** 一覧の要素（スクロールの位置を覚えて戻すのに使う） */
    ref?: (el: HTMLElement) => void;
    /** フォーカスしているワークスペースが無いときの「+ ワークスペースを作る」 */
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
  const focused = createMemo(() => focusedRow(props.rows));
  // shj が動いているとき（と DB のタブを出している間）は、タブ・ファイルツリー・CHANGES の 3 段に分ける（#284・#374）
  const sections = () =>
    focused()?.row.band.showTree === true ||
    dbTreeTabOf(props, true) !== undefined;
  let nav!: HTMLElement;

  // 固定されているものに data-stuck を付ける（背景と影をモックに合わせる）。
  // 上に固定するものは、sticky の位置（一覧の上端から top）にいて、親の要素の上端より下にずれていれば
  // 固定されている（中身を通り過ぎて押し出された行は sticky の位置より上にいるので外れる）。
  // 影（data-shadow）は、上に固定されたものの一番下に付ける
  onMount(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      let last: HTMLElement | null = null;
      for (const el of nav.querySelectorAll<HTMLElement>("[data-sticky]")) {
        const parent = el.parentElement;
        const top = el.getBoundingClientRect().top;
        // スクロールの入れ物：3 段のときはファイルツリーの段、そうでなければ一覧
        const box = el.closest<HTMLElement>(".tree-section") ?? nav;
        const at =
          box.getBoundingClientRect().top +
          box.clientTop +
          (parseFloat(getComputedStyle(el).top) || 0);
        const stuck =
          parent !== null &&
          Math.abs(top - at) < 0.5 &&
          top > parent.getBoundingClientRect().top + 0.5;
        if (stuck) last = el;
        el.toggleAttribute("data-stuck", stuck);
        el.removeAttribute("data-shadow");
      }
      last?.setAttribute("data-shadow", "");
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    // ファイルツリーの段のスクロールも拾う（scroll は泡立たないので、キャプチャで受ける）
    nav.addEventListener("scroll", schedule, { capture: true, passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(nav);
    // 行が増減した（属性は見ない。data-stuck・data-shadow を付けても回らないように）
    const mutation = new MutationObserver(schedule);
    mutation.observe(nav, { childList: true, subtree: true });
    schedule();
    onCleanup(() => {
      nav.removeEventListener("scroll", schedule, { capture: true });
      resize.disconnect();
      mutation.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    });
  });

  return (
    <div class="sidebar-column">
      <nav
        class="sidebar"
        data-sections={sections() ? "" : undefined}
        aria-label={T("sidebar.workspaces")}
        ref={(el) => {
          nav = el;
          props.ref?.(el);
        }}
      >
        <Show
          when={focused()}
          fallback={
            <EmptyHeader
              onSwitch={props.onSwitch}
              onNew={props.onNew}
              total={props.rows.length}
            />
          }
        >
          {(f) => (
            <ul class="bands">
              <BandItem
                row={f().row}
                {...handlers(props, openTreeMenu, openBandMenu, openAddMenu)}
              />
            </ul>
          )}
        </Show>
      </nav>
      <Show when={bandMenu()} keyed>
        {(m) => (
          <PopupMenu
            x={m.x}
            y={m.y}
            label={T("sidebar.workspaces")}
            items={[
              {
                label: T("sidebar.rename"),
                run: () => props.onRenameWorkspace?.(m.gws),
              },
            ]}
            onClose={() => setBandMenu(null)}
          />
        )}
      </Show>
      <Show when={addMenu()} keyed>
        {(m) => (
          <PopupMenu
            x={m.x}
            y={m.y}
            label={T("sidebar.addTab")}
            items={[
              {
                label: T("sidebar.addTerminal"),
                run: () => props.onAddTab?.(m.gws, "terminal"),
              },
              {
                label: T("sidebar.addTerminalPick"),
                run: () => props.onAddTab?.(m.gws, "terminal.pick"),
              },
              ...(props.browser
                ? [
                    {
                      label: T("sidebar.addBrowser"),
                      run: () => props.onAddTab?.(m.gws, "browser"),
                    },
                  ]
                : []),
              {
                label: T("sidebar.addDb"),
                run: () => props.onAddTab?.(m.gws, "db"),
              },
            ]}
            onClose={() => setAddMenu(null)}
          />
        )}
      </Show>
      <Show when={treeMenu()} keyed>
        {(m) => (
          <TreeMenu
            x={m.x}
            y={m.y}
            label={m.row.name}
            items={menuItems(m.row)}
            onChoose={(a) => props.onTreeAction?.(m.target, m.id, m.row, a)}
            onClose={() => setTreeMenu(null)}
          />
        )}
      </Show>
    </div>
  );
}
