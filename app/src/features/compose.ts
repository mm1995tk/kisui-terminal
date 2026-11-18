// メインウィンドウの機能の持ち物（各 controller）を作って、互いをつなぐ。
// 持ち物どうしは互いを呼ぶ（接続の知らせでフォーカスを直す、タブを閉じたらワークスペースを移る、など）。
// 先に作る側には、後で作る側を呼ぶ関数を渡す（呼ばれるのは、全部を作り終えたあと）。
// 外への頼みの本物（FeaturePorts）と、画面の側に頼むこと（FeatureUi・CommandUi）は、呼ぶ側（ui/main-window/page.tsx）が渡す。
// ここには動きを書かない。画面にも Tauri にも触らない。
import { createSignal } from "solid-js";

import { createBookmarks } from "./browser/bookmarksStore.ts";
import { createDownloads } from "./browser/downloads.ts";
import type { BrowserOs } from "./browser/os.ts";
import { createPages } from "./browser/pages.ts";
import { createBrowserTabs } from "./browser/tabsStore.ts";
import { createChanges } from "./changes/controller.ts";
import { createCommandRunner, type CommandUi } from "./commands/run.ts";
import { createFileTree } from "./file-tree/controller.ts";
import type { KeyValueStore } from "./keyValueStore.ts";
import type { MascotOs } from "./mascot/mascot.ts";
import { createMascotStore } from "./mascot/mascotStore.ts";
import type { Problem } from "./problem.ts";
import { createScale } from "./scale/controller.ts";
import type { ApplyScale } from "./scale/scale.ts";
import { createSessions } from "./sessions/controller.ts";
import type { ConfigMachine } from "./sessions/machines.ts";
import type { ShellApi } from "./sessions/shell.ts";
import { createTerminals } from "./terminal/controller.ts";
import type { OpenUrlExternally } from "./terminal/urlOpen.ts";
import { createUpdates, type UpdatesOs } from "./updates/store.ts";
import { createWorkspaces } from "./workspaces/controller.ts";
import { routePaneEvent } from "./workspaces/paneEvents.ts";
import { createPrimaryShj } from "./workspaces/primaryShj.ts";
import { createTabs } from "./workspaces/tabs/controller.ts";
import type { WorkspaceId } from "../infrastructure/rpc/protocol.ts";

/** 機能が外に頼むこと（本物は infrastructure/。index.tsx が組み立てる）。 */
export interface FeaturePorts {
  /** 接続（ssh・kisui attach）と設定ファイル */
  shell: ShellApi;
  /** 小さな記録の置き場（使えない環境では undefined。そのときは覚えない） */
  store: KeyValueStore | undefined;
  /** 内蔵ブラウザのタブ */
  browser: BrowserOs;
  /** 外部ブラウザ */
  openUrl: OpenUrlExternally;
  /** 窓の中の画面全体の大きさ */
  applyScale: ApplyScale;
  /** キャラクター */
  mascot: MascotOs;
  /** 新しい版 */
  updates: UpdatesOs;
}

/** 機能が、画面の側に頼むこと（キーを向ける・スクロールを戻す・短い知らせを出す）。 */
export interface FeatureUi {
  /** 今使っているペイン（ブラウザのタブを出していればそのページ）にキーを向ける */
  focusTerminal(): void;
  /** ページから押したときに覚えた「キーを戻す先」を捨てる */
  forgetPageReturn(): void;
  /** 閉じているサイドバーを開ける */
  revealSidebar(): void;
  /** ツリーの描き直しのあとで、スクロールの位置を top に戻す */
  restoreTreeScroll(top: number): void;
  /** ページ内検索の欄の入力欄にキーを向ける */
  focusFind(): void;
  /** shj が引数なしで起動した直後の、ツリーへのフォーカスの頼み */
  requestStartFocus(target: string, id: WorkspaceId): void;
  /** サイドバーのファイルツリーにキーを向ける */
  focusExplorer(target: string, id: WorkspaceId): void;
  /** サイドバーの CHANGES にキーを向ける */
  focusChanges(target: string, id: WorkspaceId): void;
  /** OS のクリップボードに入れ、書けたときだけ「コピーしました」を出す */
  copyToClipboard(text: string): Promise<void>;
  /** 変えた大きさを少しの間見せる */
  showScale(v: number): void;
  /** 少しの間だけ出る短い知らせ */
  showToast(text: string): void;
}

/** createFeatures が返す、メインウィンドウの機能の持ち物の全部。 */
export type Features = ReturnType<typeof createFeatures>;

/** メインウィンドウの機能の持ち物を全部作り、互いをつないで返す。Solid の所有者（コンポーネントか createRoot）の中で 1 回だけ呼ぶ。 */
export function createFeatures(deps: {
  ports: FeaturePorts;
  /** 手元の設定ファイルで決めたマシン */
  config: ConfigMachine[];
  /** 内蔵ブラウザのタブを使うか（設定の [gui.browser] enabled。#202） */
  browser: boolean;
  /** macOS か */
  mac: boolean;
  ui: FeatureUi;
  commandUi: CommandUi;
}) {
  const { ports, browser, ui } = deps;
  const store = ports.store;
  // ワークスペースに移れなかった・ファイルを開けなかったなど、できなかったことの知らせ（見出しと本文）。無ければ null
  const [focusError, setFocusError] = createSignal<Problem | null>(null);
  const focusTerminal = () => ui.focusTerminal();
  const forgetPageReturn = () => ui.forgetPageReturn();

  const updates = createUpdates(ports.updates);
  const mascot = createMascotStore(ports.mascot);
  const sessions = createSessions({
    api: ports.shell,
    store,
    config: deps.config,
    hooks: {
      treeChanged: () => fileTree.changed(),
      termChanged: () => terminals.changed(),
      firstList: (target, list) => workspaces.firstList(target, list),
      shjFocus: () => workspaces.shjFocusChanged(),
      pane: (target, ev, s) =>
        routePaneEvent(
          {
            paneShow: terminals.paneShow,
            paneShowExtra: terminals.paneShowExtra,
            requestStartFocus: (t, id) => ui.requestStartFocus(t, id),
            focusExplorer: (t, id) => ui.focusExplorer(t, id),
            focusChanges: (t, id) => ui.focusChanges(t, id),
            openUrlFor: pages.openUrlFor,
            checkNow: updates.checkNow,
            zoomWs: terminals.zoomWs,
          },
          target,
          ev,
          s,
        ),
    },
  });
  const terminals = createTerminals({
    sessions: sessions.sessions,
    workspaces: sessions.workspaces,
    termGroups: sessions.termGroups,
    focus: () => workspaces.focus(),
    focusTerminal,
  });
  const browserTabs = createBrowserTabs({ os: ports.browser });
  const workspaces = createWorkspaces({
    store,
    browser,
    sessions,
    browserTabs,
    closeTabView: ports.browser.closeTabView,
    setFocusError,
    focusTerminal,
    forgetPageReturn,
    revealSidebar: () => ui.revealSidebar(),
  });
  const askPrimaryShj = createPrimaryShj({
    sessions: sessions.sessions,
    workspaces: sessions.workspaces,
    isSwitching: workspaces.isSwitching,
    extraShown: terminals.extraShown,
    termGroup: terminals.termGroup,
    focusTerminal,
    setFocusError,
  });
  const fileTree = createFileTree({
    sessions: sessions.sessions,
    workspaces: sessions.workspaces,
    trees: sessions.trees,
    focus: workspaces.focus,
    folderOf: workspaces.folderOf,
    rootOf: workspaces.rootOf,
    walking: workspaces.walking,
    askPrimaryShj,
    copyToClipboard: (text) => ui.copyToClipboard(text),
    restoreScroll: (top) => ui.restoreTreeScroll(top),
    setFocusError,
  });
  const changes = createChanges({
    sessions: sessions.sessions,
    workspaces: sessions.workspaces,
    focus: workspaces.focus,
    rootOf: workspaces.rootOf,
    walking: workspaces.walking,
    isSwitching: workspaces.isSwitching,
    askPrimaryShj,
    termGroup: terminals.termGroup,
    focusTerminal,
    setFocusError,
  });
  const pages = createPages({
    os: ports.browser,
    browser,
    mac: deps.mac,
    browserTabs,
    workspaces,
    openUrlExternally: ports.openUrl,
    removeTab: (id, back) => tabs.removeTab(id, back),
    setFocusError,
    focusTerminal,
    forgetPageReturn,
    focusFind: () => ui.focusFind(),
    showScale: (v) => ui.showScale(v),
  });
  const bookmarks = createBookmarks({
    os: ports.browser,
    openTab: (url, title) => tabs.openBrowserTab(url, title),
    newTabPageId: pages.newTabPageId,
    showToast: (text) => ui.showToast(text),
    setFocusError,
    cannot: workspaces.cannot,
    focusTerminal,
  });
  const downloads = createDownloads({
    os: ports.browser,
    browser,
    setFocusError,
  });
  const tabs = createTabs({
    sessions,
    workspaces,
    browserTabs,
    pages,
    setFocusError,
    focusTerminal,
  });
  const scale = createScale({
    store,
    applyScale: ports.applyScale,
    showScale: (v) => ui.showScale(v),
  });
  const commands = createCommandRunner({
    workspaces,
    tabs,
    terminals,
    browserTabs,
    pages,
    bookmarks,
    downloads,
    updates,
    mascot,
    scale,
    os: ports.browser,
    setFocusError,
    focusTerminal,
    ui: deps.commandUi,
  });

  return {
    /** できなかったことの知らせ（無ければ null） */
    focusError,
    setFocusError,
    updates,
    mascot,
    sessions,
    terminals,
    browserTabs,
    workspaces,
    fileTree,
    changes,
    pages,
    bookmarks,
    downloads,
    tabs,
    scale,
    commands,
  };
}
