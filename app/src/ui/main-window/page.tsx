// メインウィンドウの入口。機能の持ち物（features/）を作ってつなぎ、割り付け（layout.tsx）に部品を並べる。
// ここには動きを書かない。接続・ワークスペース・タブ・ブラウザーなどの状態と操作は features/ の各 controller にあり、
// キーの入力（keys.ts）・キーの行き先（focus.ts）・境界の大きさ（paneResize.ts）は、この画面の表示用の状態として隣に置く。
// 配置と依存の向きの決まりは docs/design/frontend-structure.md。
//
// 画面の中身：
// - 左のサイドバーに、ワークスペースの帯と中のタブ、フォーカスしているワークスペースのファイルツリーと CHANGES を出す（sidebar/）。
// - 右のペインに、フォーカスしているワークスペースのターミナル（内蔵ブラウザのタブを出していればそのページ）を出す（content/）。
// - 窓（接続・ワークスペース・ツリー・ブックマークなど）と、右下の知らせ・リーダーの案内を、上に重ねて出す。
import { createSignal, onMount, Show, untrack, type JSX } from "solid-js";

import { createBookmarks } from "../../features/browser/bookmarksStore.ts";
import { createDownloads } from "../../features/browser/downloads.ts";
import { createPages } from "../../features/browser/pages.ts";
import { createBrowserTabs } from "../../features/browser/tabsStore.ts";
import { createChanges } from "../../features/changes/controller.ts";
import { OsClipboard } from "../../features/clipboard/osClipboard.ts";
import {
  setBrowserEnabled,
  setUserShortcuts,
} from "../../features/commands/commands.ts";
import { IS_MAC } from "../../features/commands/guiKeys.ts";
import { placeOf } from "../../features/commands/placeKeys.ts";
import { createCommandRunner } from "../../features/commands/run.ts";
import { createFileTree } from "../../features/file-tree/controller.ts";
import { createMascotStore } from "../../features/mascot/mascotStore.ts";
import type { Problem } from "../../features/problem.ts";
import { createScale } from "../../features/scale/controller.ts";
import { createSessions } from "../../features/sessions/controller.ts";
import type { ConfigMachine } from "../../features/sessions/machines.ts";
import { createTerminals } from "../../features/terminal/controller.ts";
import { createUpdates } from "../../features/updates/store.ts";
import { createWorkspaces } from "../../features/workspaces/controller.ts";
import { routePaneEvent } from "../../features/workspaces/paneEvents.ts";
import { createPrimaryShj } from "../../features/workspaces/primaryShj.ts";
import { createTabs } from "../../features/workspaces/tabs/controller.ts";
import { PortsContext, type Ports } from "../ports.ts";
// ここから下の、CSS を持つ部品の import は、順を変えない。CSS の規則は import の順に並び、同じ強さの規則は後のものが勝つ。
// App.tsx を分ける前（#313）の順（キーの一覧 → トースト → サイドバー → 切り替える窓 → 割り付け → ブラウザ → リーダーの案内 → ターミナル）を保っている。
import { KeyListDialog, openKeyList } from "./commands/KeyListDialog.tsx";
import {
  CopiedToast,
  copiedNotice,
  showToast,
} from "./notifications/CopiedToast.tsx";
import { ScaleToast, showScale } from "./notifications/ScaleToast.tsx";
import { Sidebar } from "./sidebar/Sidebar.tsx";
import { WorkspaceDialogs } from "./workspaces/WorkspaceDialogs.tsx";
import { MainWindowLayout } from "./layout.tsx";
import { ContentArea } from "./content/ContentArea.tsx";
// ここまで
import { ClipboardDialog } from "./clipboard/ClipboardDialog.tsx";
import {
  ClipboardHistoryDialog,
  openClipboardHistory,
} from "./clipboard/ClipboardHistoryDialog.tsx";
import { LeaderMenu } from "./commands/LeaderMenu.tsx";
import { BookmarkDialog } from "./content/browser/BookmarkDialog.tsx";
import type { WindowEls } from "./els.ts";
import { TransferDialog } from "./file-transfer/TransferDialog.tsx";
import { createFocus } from "./focus.ts";
import { createGuiKeys } from "./keys.ts";
import { MascotDialog } from "./mascot/MascotDialog.tsx";
import { copyAndNotify } from "./notifications/copiedNotice.ts";
import { Notices } from "./notifications/Notices.tsx";
import { createNotices } from "./notifications/notices.ts";
import { UpdateBar } from "./notifications/UpdateBar.tsx";
import { createPaneResize } from "./paneResize.ts";
import { sizeOf } from "./panes.ts";
import { ConfigError } from "./sessions/ConfigError.tsx";
import { SessionDialogs } from "./sessions/SessionDialogs.tsx";
import { FileTreeDialogs } from "./sidebar/file-tree/FileTreeDialogs.tsx";

/**
 * 起動したら、先に手元の設定ファイルの [[gui.machines]] を読む。間違いがあれば、場所・行・理由だけを出して、ほかは何もしない
 * （どこにもつながない）。読めたら本体（MainWindow）を出す。
 * ports は外（Tauri の殻・記録）への頼みの本物で、index.tsx が組み立てて渡す。
 */
export function MainWindowPage(props: { ports: Ports }): JSX.Element {
  const api = props.ports.shell;
  const [loaded, setLoaded] = createSignal<
    | {
        config: ConfigMachine[];
        browser: boolean;
        shortcutProblems: string[];
        tabsHeight?: number;
      }
    | { error: string }
    | null
  >(null);
  onMount(() => {
    api.configGui().then(
      (g) => {
        // 内蔵ブラウザ（#202）は、設定で有効にしたときだけ、リーダーの o のグループを出す
        setBrowserEnabled(g.browser);
        // 近道の間違い（読めないキー・知らないコマンド）では止めず、お知らせで知らせる
        const shortcutProblems = setUserShortcuts(g.shortcuts, IS_MAC);
        setLoaded({
          config: g.machines,
          browser: g.browser,
          shortcutProblems,
          tabsHeight: g.sidebarTabsHeight ?? undefined,
        });
      },
      (e) => setLoaded({ error: String(e) }),
    );
  });
  return (
    <PortsContext.Provider value={props.ports}>
      <Show when={loaded()}>
        {(l) => {
          const v = l();
          return "error" in v ? (
            <ConfigError message={v.error} />
          ) : (
            <MainWindow
              ports={props.ports}
              config={v.config}
              browser={v.browser}
              tabsHeight={v.tabsHeight}
              shortcutProblems={v.shortcutProblems}
            />
          );
        }}
      </Show>
    </PortsContext.Provider>
  );
}

function MainWindow(props: {
  ports: Ports;
  /** 手元の設定ファイルで決めたマシン */
  config: ConfigMachine[];
  /** 内蔵ブラウザのタブを使うか（設定の [gui.browser] enabled。#202） */
  browser: boolean;
  /** 設定の [gui.shortcuts] の間違い（あればお知らせに出す） */
  shortcutProblems: string[];
  /** タブの段の高さの上限の元の値（設定の [gui.sidebar] tabs-height。サイドバーの高さに対する %）。無ければ 40 */
  tabsHeight?: number;
}): JSX.Element {
  // 設定は起動のときに 1 回読んだもので、出している間は変わらない
  const { ports, browser } = props;
  const store = ports.store;
  const els: WindowEls = {};
  // ワークスペースに移れなかった・ファイルを開けなかったなど、できなかったことの知らせ（見出しと本文）。無ければ null
  const [focusError, setFocusError] = createSignal<Problem | null>(null);

  // 画面の側ですること。持ち物どうしは互いを呼び合うので、あとで作るものは、呼ばれたときに引く
  const focusTerminal = () => focusUi.focusTerminal();
  const forgetPageReturn = () => focusUi.forgetPageReturn();
  const clipboard = new OsClipboard(
    () => navigator.clipboard,
    (e) => console.warn("clipboard:", e),
  );
  /** OS のクリップボードに入れ、書けたときだけ「コピーしました」を出す。 */
  async function copyToClipboard(text: string) {
    await copyAndNotify(
      () => clipboard.write(text),
      () => copiedNotice.show(),
    );
  }

  // ---- 機能の持ち物（features/）----
  const updates = createUpdates(ports.updates);
  const mascot = createMascotStore(ports.mascot);
  const sessions = createSessions({
    api: ports.shell,
    store,
    config: props.config,
    hooks: {
      treeChanged: () => fileTree.changed(),
      termChanged: () => terminals.changed(),
      workspacesChanged: () => workspaces.workspacesChanged(),
      firstList: (target, list) => workspaces.firstList(target, list),
      shjFocus: (target, id) => workspaces.shjFocusChanged(target, id),
      pane: (target, ev, s) =>
        routePaneEvent(
          {
            paneShow: terminals.paneShow,
            paneShowExtra: terminals.paneShowExtra,
            requestStartFocus: focusUi.requestStartFocus,
            focusExplorer: focusUi.focusExplorer,
            focusChanges: focusUi.focusChanges,
            openUrlFor: pages.openUrlFor,
            checkNow: updates.checkNow,
            zoomWs: terminals.zoomWs,
          },
          target,
          ev,
          s,
        ),
      disconnected: () => workspaces.disconnected(),
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
    revealSidebar: () => {
      if (!untrack(resize.sidebarOpen)) resize.changeSidebarOpen(true);
    },
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
    copyToClipboard,
    restoreScroll: (top) => resize.restoreScrollTo(top),
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
    mac: IS_MAC,
    browserTabs,
    workspaces,
    openUrlExternally: ports.openUrl,
    removeTab: (id, back) => tabs.removeTab(id, back),
    setFocusError,
    focusTerminal,
    forgetPageReturn,
    focusFind: () => focusUi.focusFind(),
    showScale,
  });
  const bookmarks = createBookmarks({
    os: ports.browser,
    browserTabs,
    focus: workspaces.focus,
    newTabPageId: pages.newTabPageId,
    showToast,
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
    showScale,
  });

  // ---- この画面の表示用の状態（境界の大きさ・キーの行き先・窓の開閉・知らせ・キーの入力）----
  const resize = createPaneResize({
    store,
    tabsHeight: props.tabsHeight,
    els,
    focus: workspaces.focus,
    rows: workspaces.rows,
    termGroup: terminals.termGroup,
    termBars: terminals.termBars,
    changesOf: changes.changesOf,
    walking: workspaces.walking,
    treeScrollTop: fileTree.scrollTop,
    rememberTreeScroll: fileTree.rememberScroll,
    focusTerminal,
  });
  const focusUi = createFocus({
    els,
    browser,
    focus: workspaces.focus,
    workspaces: sessions.workspaces,
    treeVersion: fileTree.treeVersion,
    shownBrowserTab: pages.shownBrowserTab,
    sidebarOpen: resize.sidebarOpen,
    changeSidebarOpen: resize.changeSidebarOpen,
    resizeMode: resize.resizeMode,
    inLeader: () => keys.inLeader(),
  });
  const notices = createNotices({
    shortcutProblems: props.shortcutProblems,
    focusError,
    setFocusError,
    sessions,
    downloads,
  });
  // マシンのダイアログ（リーダーの m）を出しているか
  const [machinesOpen, setMachinesOpen] = createSignal(false);
  // キャラクターを選ぶ窓（リーダーの c s）を出しているか
  const [mascotPicking, setMascotPicking] = createSignal(false);
  // ワークスペースを切り替える窓（リーダーの w）を出しているか（サイドバーの見出しからも開く）
  const [wsSwitcher, setWsSwitcher] = createSignal(false);
  const runner = createCommandRunner({
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
    ui: {
      toggleResizeMode: () => resize.setResizeMode(!resize.resizeMode()),
      toggleSidebar: resize.toggleSidebar,
      openMachines: () => setMachinesOpen(true),
      openWorkspaceSwitcher: () => setWsSwitcher(true),
      openClipboardHistory,
      openMascotPicker: () => setMascotPicking(true),
      openKeyList: () => openKeyList(placeOf(document.activeElement)),
      focusUrlBar: focusUi.focusUrlBar,
      forgetPageReturn,
      copyToClipboard,
      dismissLastNotice: () => notices().at(-1)?.dismiss?.(),
    },
  });
  const keys = createGuiKeys({
    els,
    shell: ports.shell,
    onTabKey: browser ? ports.browser.onTabKey : undefined,
    resizeMode: resize.resizeMode,
    resizeKey: resize.resizeKey,
    shownBrowserTab: pages.shownBrowserTab,
    termGroup: terminals.termGroup,
    runCommand: runner.runCommand,
    endWalk: workspaces.endWalk,
    focusUi,
  });

  return (
    <MainWindowLayout
      ref={(el) => (els.app = el)}
      resizing={resize.resizeMode()}
      sidebarOpen={resize.sidebarOpen()}
      sidebarWidth={sizeOf(resize.sizes(), "sidebar")}
      changesHeight={sizeOf(resize.sizes(), "changes")}
      tabsPct={resize.tabsPct()}
      litSidebar={resize.lit("sidebar")}
      litChanges={resize.lit("changes")}
      litTabs={resize.lit("tabs")}
      machineColor={sessions.colors()[workspaces.focus()?.target ?? ""]}
      onSidebarResize={(e) => resize.dragBorder("sidebar", e)}
      onSidebarResizeReset={() => resize.resetSize("sidebar")}
      sidebar={
        <Sidebar
          rows={workspaces.rows()}
          onNew={workspaces.newWorkspace}
          // ヘッダーの名前を押すと、ワークスペースを切り替えるポップアップ（リーダーの w）を開く
          onSwitch={() => setWsSwitcher(true)}
          onTab={tabs.selectTab}
          onTabClose={tabs.closeTabRow}
          onTabRename={tabs.renameTabRow}
          onAddTab={(gid, what) => void tabs.addWorkspaceTab(gid, what)}
          browser={browser}
          onTabMove={tabs.moveTabBefore}
          treeOf={fileTree.treeOf}
          onToggle={fileTree.toggle}
          onClose={(gid) => void workspaces.closeWorkspace(gid)}
          onRenameWorkspace={workspaces.openWorkspaceRename}
          renaming={
            workspaces.renamingWs()
              ? {
                  ...workspaces.renamingWs()!,
                  error: workspaces.wsRenameError(),
                }
              : null
          }
          onRenameSubmit={workspaces.submitWorkspaceRename}
          onRenameCancel={workspaces.cancelWorkspaceRename}
          onOpen={fileTree.openFile}
          changesOf={changes.changesOf}
          onChange={changes.openChange}
          onChangesKey={changes.changesShjKey}
          onChangesExplorer={focusUi.focusExplorer}
          onChangesLeave={() => focusTerminal()}
          onTabsResize={resize.dragTabs}
          onTabsResizeReset={() => resize.resetSize("tabs")}
          onChangesResize={resize.dragChanges}
          onChangesResizeReset={() => resize.resetSize("changes")}
          onTreeAction={fileTree.treeAction}
          currentOf={fileTree.currentOf}
          ref={(el) => {
            els.nav = el;
            el.addEventListener("scroll", resize.rememberScroll, {
              capture: true,
              passive: true,
            });
          }}
        />
      }
      content={
        <ContentArea
          ref={(el) => (els.main = el)}
          browser={browser}
          terminals={terminals}
          browserTabs={browserTabs}
          pages={pages}
          bookmarks={bookmarks}
          focusUi={focusUi}
          litSplit={resize.litSplit()}
          accent={sessions.colors()[terminals.termTarget() ?? ""]}
          scale={scale.scale}
          setFocusError={setFocusError}
        />
      }
    >
      <SessionDialogs
        sessions={sessions}
        machineList={workspaces.machineList}
        currentTarget={workspaces.currentTarget}
        machinesOpen={machinesOpen()}
        onCloseMachines={() => setMachinesOpen(false)}
      />
      <WorkspaceDialogs
        sessions={sessions}
        workspaces={workspaces}
        tabs={tabs}
        browserTabs={browserTabs}
        switcherOpen={wsSwitcher()}
        onCloseSwitcher={() => setWsSwitcher(false)}
      />
      <Show when={mascotPicking()}>
        <MascotDialog
          list={mascot.list}
          onChoose={(name) => {
            setMascotPicking(false);
            runner.chooseMascot(name);
          }}
          onCancel={() => setMascotPicking(false)}
        />
      </Show>
      <FileTreeDialogs fileTree={fileTree} />
      <Show when={bookmarks.bookmarkDialog()}>
        <BookmarkDialog
          own={bookmarks.bookmarks()}
          chrome={bookmarks.chromeBookmarks()}
          failed={bookmarks.failed()}
          onOpen={bookmarks.openBookmark}
          onDelete={bookmarks.deleteBookmark}
          onCancel={bookmarks.closeDialog}
        />
      </Show>
      <ClipboardDialog />
      <ClipboardHistoryDialog />
      <TransferDialog />
      <CopiedToast overPage={!!pages.shownBrowserTab()} />
      <ScaleToast overPage={!!pages.shownBrowserTab()} />
      <LeaderMenu mascot={mascot} />
      <KeyListDialog />
      <Notices notices={notices()}>
        <UpdateBar updates={updates} />
      </Notices>
    </MainWindowLayout>
  );
}
