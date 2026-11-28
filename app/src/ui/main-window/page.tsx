// メインウィンドウの入口。機能の持ち物（features/）とこの画面の表示用の状態を作り、割り付け（layout.tsx）に部品を並べる。
// ここには動きを書かない。接続・ワークスペース・タブ・ブラウザーなどの状態と操作は features/ の各 controller にあり（つなぐのは features/compose.ts）、
// キーの入力（keys.ts）・キーの行き先（focus.ts）・Pane border の大きさ（paneResize.ts）は、この画面の表示用の状態として隣に置く。
// 配置と依存の向きの決まりは docs/design/frontend-structure.md。
//
// 画面の中身：
// - 左のサイドバーに、Workspace band と中のタブ、フォーカスしているワークスペースのファイルツリーと CHANGES を出す（sidebar/）。
// - 右のペインに、フォーカスしているワークスペースのターミナル（内蔵ブラウザのタブを出していればそのページ、DB のタブならその画面）を出す（content/）。
// - Dialog（接続・ワークスペース・ツリー・ブックマークなど）と、右下の知らせ・リーダーの案内を、上に重ねて出す。
import {
  createEffect,
  createSignal,
  on,
  onMount,
  Show,
  untrack,
  type JSX,
} from "solid-js";

import { OsClipboard } from "../../features/clipboard/osClipboard.ts";
import {
  setBrowserEnabled,
  setUserShortcuts,
} from "../../features/commands/commands.ts";
import { IS_MAC } from "../../features/commands/guiKeys.ts";
import type { TabKind } from "../../features/commands/tabWindow.ts";
import { placeOf } from "../../features/commands/placeKeys.ts";
import { createFeatures } from "../../features/compose.ts";
import type { Problem } from "../../features/problem.ts";
import type { ConfigMachine } from "../../features/sessions/machines.ts";
import type { TermDefaults } from "../../features/sessions/termDefaults.ts";
import { moveMachineRecords } from "../../features/sessions/moveRecords.ts";
import { PortsContext, type Ports } from "../ports.ts";
// ここから下の、CSS を持つ部品の import は、順を変えない。CSS の規則は import の順に並び、同じ強さの規則は後のものが勝つ。
// 順は、キーの一覧 → トースト → サイドバー → Workspace switcher → 割り付け → ブラウザ → リーダーの案内 → ターミナル → 空のワークスペース → DB のタブ（cssOrder.test.ts が見張る）。
import { KeyListDialog, openKeyList } from "./commands/KeyListDialog.tsx";
import {
  CopiedToast,
  copiedNotice,
  showToast,
} from "./notifications/CopiedToast.tsx";
import { ScaleToast, showScale } from "./notifications/ScaleToast.tsx";
import { Sidebar } from "./sidebar/Sidebar.tsx";
import {
  WorkspaceDialogs,
  type SwitcherOpen,
} from "./workspaces/WorkspaceDialogs.tsx";
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
import { DbDialogs } from "./db/DbDialogs.tsx";
import { SessionDialogs } from "./sessions/SessionDialogs.tsx";
import { FileTreeDialogs } from "./sidebar/file-tree/FileTreeDialogs.tsx";
import { TabWindows } from "./tab-window/TabWindows.tsx";

/**
 * 起動したら、先に手元の設定ファイルの [[gui.machines]] を読む。間違いがあれば、場所・行・理由だけを出して、ほかは何もしない
 * （どこにもつながない）。読めたら、前の版が localStorage に記録した「Window で足したマシン」を config.local.toml に移し（初めの 1 度だけ）、
 * 本体（MainWindow）を出す。
 * ports は外（Tauri の殻・記録）への頼みの本物で、index.tsx が組み立てて渡す。
 */
export function MainWindowPage(props: { ports: Ports }): JSX.Element {
  const api = props.ports.shell;
  const [loaded, setLoaded] = createSignal<
    | {
        config: ConfigMachine[];
        localTerminal?: TermDefaults | null;
        browser: boolean;
        shortcutProblems: string[];
        passkeyRejected: string[];
        tabsHeight?: number;
        startupProblem?: Problem;
      }
    | { error: string }
    | null
  >(null);
  onMount(() => {
    api.configGui().then(
      async (g) => {
        // 前の版の記録を移す。移せなかったマシンは、知らせに出す（起動は止めない）
        const moved = await moveMachineRecords({
          api,
          store: props.ports.store,
          config: g.machines,
        });
        // 内蔵ブラウザ（#202）は、設定で有効にしたときだけ、ブラウザの操作（ブラウザのタブの Dialog と、設定の Shortcut の browser.*）を使えるようにする
        setBrowserEnabled(g.browser);
        // Shortcut の間違い（読めないキー・知らないコマンド）では止めず、Notice で知らせる
        const shortcutProblems = setUserShortcuts(g.shortcuts, IS_MAC);
        setLoaded({
          config: moved.machines,
          localTerminal: g.localTerminal,
          startupProblem: moved.problem,
          browser: g.browser,
          shortcutProblems,
          // passkey_sites の公開サフィックスの項目（使わない）。内蔵ブラウザを使うときだけ知らせる
          passkeyRejected: g.browser ? g.passkeyRejected : [],
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
              localTerminal={v.localTerminal}
              browser={v.browser}
              tabsHeight={v.tabsHeight}
              shortcutProblems={v.shortcutProblems}
              passkeyRejected={v.passkeyRejected}
              startupProblem={v.startupProblem}
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
  /** 手元のマシンの、新しいターミナルが始まるフォルダとシェル（設定の [server] start_dir・shell。#485） */
  localTerminal?: TermDefaults | null;
  /** 内蔵ブラウザのタブを使うか（設定の [gui.browser] enabled。#202） */
  browser: boolean;
  /** 設定の [gui.shortcuts] の間違い（あれば Notice に出す） */
  shortcutProblems: string[];
  /** 設定の [gui.browser] passkey_sites の、公開サフィックスなので使わない項目（あれば Notice に出す） */
  passkeyRejected: string[];
  /** タブの段の高さの上限の元の値（設定の [gui.sidebar] tabs-height。サイドバーの高さに対する %）。無ければ 40 */
  tabsHeight?: number;
  /** 起動のときから右下に出しておく、できなかったこと（前の版のマシンの記録を移せなかった） */
  startupProblem?: Problem;
}): JSX.Element {
  // 設定は起動のときに 1 回読んだもので、出している間は変わらない
  const { ports, browser } = props;
  const els: WindowEls = {};
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
  // マシンのダイアログ（リーダーの m）を出しているか
  const [machinesOpen, setMachinesOpen] = createSignal(false);
  // キャラクターを選ぶ Dialog（リーダーの c s）を出しているか
  const [mascotPicking, setMascotPicking] = createSignal(false);
  // Workspace switcher（リーダーの w・t・n）を出しているか（出していれば、開いたときの初めの状態。サイドバーの見出しからも、マシンのダイアログの Enter からも開く）
  const [wsSwitcher, setWsSwitcher] = createSignal<SwitcherOpen | undefined>();
  // 今出しているタブの種類ごとの Dialog（リーダーの a）を出しているか（出していれば、その種類）
  const [tabWindow, setTabWindow] = createSignal<TabKind | undefined>();

  // ---- 機能の持ち物（features/）。画面の側ですること（下で作る resize・focusUi・notices）は、呼ばれたときに引く ----
  const {
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
    db,
    bookmarks,
    downloads,
    tabs,
    scale,
    proxy,
    commands,
  } = createFeatures({
    ports,
    config: props.config,
    localTerminal: props.localTerminal,
    startupProblem: props.startupProblem,
    browser,
    mac: IS_MAC,
    ui: {
      focusTerminal: () => focusUi.focusTerminal(),
      forgetPageReturn: () => focusUi.forgetPageReturn(),
      revealSidebar: () => {
        if (!untrack(resize.sidebarOpen)) resize.changeSidebarOpen(true);
      },
      restoreTreeScroll: (top) => resize.restoreScrollTo(top),
      focusFind: () => focusUi.focusFind(),
      requestStartFocus: (target, id) => focusUi.requestStartFocus(target, id),
      focusExplorer: (target, id) => focusUi.focusExplorer(target, id),
      focusChanges: (target, id) => focusUi.focusChanges(target, id),
      copyToClipboard,
      showScale,
      showToast,
      focusProxyPanel: () => focusUi.focusProxyPanel(),
    },
    commandUi: {
      toggleResizeMode: () => resize.setResizeMode(!resize.resizeMode()),
      toggleSidebar: () => resize.toggleSidebar(),
      openMachines: () => setMachinesOpen(true),
      openWorkspaceSwitcher: (start) => setWsSwitcher(start),
      openTabWindow: (kind) => setTabWindow(kind),
      openClipboardHistory,
      openMascotPicker: () => setMascotPicking(true),
      openKeyList: () => openKeyList(placeOf(document.activeElement)),
      focusUrlBar: () => focusUi.focusUrlBar(),
      focusDbTree: () => focusUi.focusDbTree(),
      forgetPageReturn: () => focusUi.forgetPageReturn(),
      copyToClipboard,
      dismissLastNotice: () => notices().at(-1)?.dismiss?.(),
    },
  });

  // ---- この画面の表示用の状態（Pane border の大きさ・キーの行き先・知らせ・キーの入力）----
  const focusTerminal = () => focusUi.focusTerminal();
  // 右の欄の配置（隠している間は 1 つだけ出るので、分けていないものとする）
  const termLayout = () =>
    terminals.zoomed() ? undefined : terminals.termLayout();
  const resize = createPaneResize({
    store: ports.store,
    tabsHeight: props.tabsHeight,
    els,
    focus: workspaces.focus,
    rows: workspaces.rows,
    termGroup: terminals.termGroup,
    termLayout,
    termBars: terminals.termBars,
    changesOf: changes.changesOf,
    walking: workspaces.walking,
    dbShown: () => db.shownDbTab() !== undefined,
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
    newTabShown: () => pages.newTabPageId() !== undefined,
    shownDbTab: db.shownDbTab,
    emptyShown: workspaces.currentEmpty,
    sidebarOpen: resize.sidebarOpen,
    changeSidebarOpen: resize.changeSidebarOpen,
    resizeMode: resize.resizeMode,
    inLeader: () => keys.inLeader(),
  });
  /**
   * 新しいタブのページを出しているなら、検索欄にキーを向ける（#545）。Workspace switcher・「+」のメニューを閉じたあとは、
   * Dialog が戻す先の要素より後にしたいので、描いたあとに向ける。
   */
  const focusNewTabPage = (onlyIfChanged = false) =>
    requestAnimationFrame(() => {
      const now = pages.newTabPageId();
      if (now === undefined) return;
      // Workspace switcher を閉じたとき、開いている間に新しいタブのページを出したのでなければ、Dialog が戻した先（ファイルツリーなど）に残す
      if (onlyIfChanged && now === newTabAtSwitcherOpen) return;
      focusUi.focusTerminal();
    });
  // Workspace switcher を開いたときに出していた新しいタブのページ
  let newTabAtSwitcherOpen: string | undefined;
  createEffect(
    on(wsSwitcher, (open, prev) => {
      if (open && !prev) newTabAtSwitcherOpen = untrack(pages.newTabPageId);
    }),
  );
  const notices = createNotices({
    shortcutProblems: props.shortcutProblems,
    passkeyRejected: props.passkeyRejected,
    focusError,
    setFocusError,
    sessions,
    downloads,
  });
  const keys = createGuiKeys({
    els,
    shell: ports.shell,
    onTabKey: browser ? ports.browser.onTabKey : undefined,
    resizeMode: resize.resizeMode,
    resizeKey: resize.resizeKey,
    shownBrowserTab: pages.shownBrowserTab,
    shownDbTab: db.shownDbTab,
    termGroup: terminals.termGroup,
    runCommand: commands.runCommand,
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
      termLayout={termLayout()}
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
          onSwitch={() => setWsSwitcher("ws")}
          onTab={tabs.selectTab}
          onTabClose={tabs.closeTabRow}
          onTabRename={tabs.renameTabRow}
          tabRenaming={
            tabs.renamingTab()
              ? { ...tabs.renamingTab()!, error: tabs.tabRenameError() }
              : null
          }
          onTabRenameSubmit={(name) => void tabs.submitTabRename(name)}
          onTabRenameCancel={tabs.cancelTabRename}
          onAddTab={(gid, what) =>
            void tabs.addWorkspaceTab(gid, what).then(() => focusNewTabPage())
          }
          browser={browser}
          onTabMove={tabs.moveTabBefore}
          treeOf={fileTree.treeOf}
          dbTabId={() => db.shownDbTab()?.id}
          dbTree={(id) => ({
            get catalog() {
              return db.catalogOf(id);
            },
            get expanded() {
              return db.expandedOf(id);
            },
            onToggle: (node, open) => db.toggleNode(id, node, open),
            onPreview: (schema, table) => db.previewTable(id, schema, table),
            get chosenSchema() {
              return db.defaultSchemaOf(id);
            },
            onSchema: (option) => db.setDefaultSchema(id, option),
            onReload: () => void db.reloadCatalog(id),
            // Esc：キーを SQL の入力欄に戻す（DB のタブを出していれば、focusTerminal が入力欄に向ける）
            onLeave: focusTerminal,
          })}
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
          treeEditOf={fileTree.treeEditOf}
          onTreeEditSubmit={(v) => void fileTree.submitTreeEdit(v)}
          onTreeEditCancel={() => fileTree.cancelTreeEdit()}
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
          empty={workspaces.currentEmpty()}
          terminals={terminals}
          browserTabs={browserTabs}
          pages={pages}
          db={db}
          proxy={proxy}
          labelOf={sessions.labelOf}
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
        hasWorkspace={() => !!workspaces.currentGws()}
        onNewTab={(target) => {
          // 先にマシンのダイアログを閉じる（閉じたときにフォーカスを戻す先が、Workspace switcher を閉じたときの戻り先になる）
          setMachinesOpen(false);
          setWsSwitcher({ terminalOn: target });
        }}
      />
      <WorkspaceDialogs
        workspaces={workspaces}
        tabs={tabs}
        switcherOpen={wsSwitcher()}
        onCloseSwitcher={() => {
          setWsSwitcher(undefined);
          focusNewTabPage(true);
        }}
        colors={sessions.colors()}
        browser={props.browser}
      />
      <TabWindows
        open={tabWindow()}
        shown={commands.shownTabKind()}
        onClose={(refocus) => {
          setTabWindow(undefined);
          if (refocus) focusTerminal();
        }}
        terminals={terminals}
        accent={sessions.colors()[terminals.termTarget() ?? ""]}
        onResizeMode={() => resize.setResizeMode(true)}
        db={db}
        labelOf={sessions.labelOf}
        connected={(t) => sessions.states()[t]?.kind === "connected"}
        mac={IS_MAC}
        onFocusDbTree={() => focusUi.focusDbTree()}
        shownBrowserTab={pages.shownBrowserTab}
        runBrowser={commands.runBrowserOn}
      />
      <Show when={mascotPicking()}>
        <MascotDialog
          list={mascot.list}
          onChoose={(name) => {
            setMascotPicking(false);
            commands.chooseMascot(name);
          }}
          onCancel={() => setMascotPicking(false)}
        />
      </Show>
      <FileTreeDialogs fileTree={fileTree} />
      <DbDialogs db={db} />
      <Show when={bookmarks.bookmarkDialog()}>
        <BookmarkDialog
          own={bookmarks.bookmarks()}
          firefox={bookmarks.firefoxBookmarks()}
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
