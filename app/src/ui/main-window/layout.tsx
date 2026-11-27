// メインウィンドウの割り付け。左にサイドバー、その右の境目のつまみ、右にペイン（ターミナルのグリッドとブラウザのページ）。
// Dialog・知らせ・リーダーの案内など、上に重ねて出すものは children に並べる。
// Pane border の大きさ・光らせる Pane border・マシンの色は、main.app の属性と CSS の変数で伝える（決まりは layout.css）。
// 何を出すかは決めない（決めるのは page.tsx）。
import type { JSX } from "solid-js";

import type { PaneLayout } from "../../infrastructure/rpc/protocol.ts";

import {
  PROXY_PANEL_MIN_WIDTH,
  PROXY_PANEL_RATIO,
  TREE_RESERVE_HEIGHT,
  rightMinWidth,
  termMinWidth,
} from "./panes.ts";
import { termCellWidth } from "./termCell.ts";
import "./layout.css";

/** メインウィンドウの割り付け。サイドバー・境目のつまみ・右のペインを並べ、上に重ねるもの（children）をその後ろに置く。 */
export function MainWindowLayout(props: {
  /** Window 全体の要素を受け取る */
  ref: (el: HTMLElement) => void;
  /** リサイズモードか */
  resizing: boolean;
  /** サイドバーを開けているか */
  sidebarOpen: boolean;
  /** サイドバーの幅（px） */
  sidebarWidth: number;
  /** CHANGES の一覧の高さ（px） */
  changesHeight: number;
  /** 右の欄の配置（サイドバーの幅の上限で、どのペインにも 20 列残す。分けていなければ undefined） */
  termLayout: PaneLayout | undefined;
  /** タブの段の高さの上限（サイドバーの高さに対する %） */
  tabsPct: number;
  /** サイドバーの境目を光らせるか */
  litSidebar: boolean;
  /** ファイルツリーと CHANGES の境目を光らせるか */
  litChanges: boolean;
  /** タブの段とファイルツリーの境目を光らせるか */
  litTabs: boolean;
  /** フォーカスしているワークスペースのマシンの色（無ければ付けない） */
  machineColor: string | undefined;
  /** サイドバーの境目のつまみをつかんだ */
  onSidebarResize: (e: PointerEvent) => void;
  /** サイドバーの境目のつまみをダブルクリックした（幅を元に戻す） */
  onSidebarResizeReset: () => void;
  sidebar: JSX.Element;
  content: JSX.Element;
  /** 上に重ねて出すもの（Dialog・知らせ・リーダーの案内） */
  children: JSX.Element;
}): JSX.Element {
  return (
    <main
      aria-label="shijimi-editor"
      class="app"
      ref={props.ref}
      data-resizing={props.resizing ? "" : undefined}
      data-lit-changes={props.litChanges ? "" : undefined}
      data-lit-tabs={props.litTabs ? "" : undefined}
      data-sidebar={props.sidebarOpen ? "open" : "closed"}
      style={{
        "--sidebar-w": `${props.sidebarWidth}px`,
        "--changes-h": `${props.changesHeight}px`,
        "--term-min-w": `${termMinWidth(termCellWidth(), props.termLayout)}px`,
        "--proxy-panel-min-w": `${PROXY_PANEL_MIN_WIDTH}px`,
        "--proxy-panel-ratio": String(PROXY_PANEL_RATIO),
        "--right-min-w-proxy": `${rightMinWidth(termCellWidth(), true, props.termLayout)}px`,
        "--tree-reserve-h": `${TREE_RESERVE_HEIGHT}px`,
        "--tabs-h": String(props.tabsPct),
        ...(props.machineColor
          ? { "--machine-color": props.machineColor }
          : {}),
      }}
    >
      {props.sidebar}
      <div
        class="resizer"
        data-axis="x"
        data-border="sidebar"
        data-lit={props.litSidebar ? "" : undefined}
        aria-hidden="true"
        onPointerDown={(e) => props.onSidebarResize(e)}
        onDblClick={() => props.onSidebarResizeReset()}
      />
      {props.content}
      {props.children}
    </main>
  );
}
