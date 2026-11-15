// 接続の画面（C3〜C7）。サイドバーに出るのは「ローカル」と、足したマシンだけ。起動時は、そのどれにも自動でつなぐ（C5）。
// 左の一覧の一番下の「+ リモートを足す」で窓を出し、ssh の行き先（~/.ssh/config のホストの候補か、打ったもの）を入れて
// shj につなぎ、つながったらマシンを保存して見出しを出す（connect/AddMachine.tsx。保存は ssh/machines.ts）。
// 足したマシンの見出しを右クリックすると、名前を変える・外す（外しても、そのマシンの kisui serve は止めない）。ssh の質問（パスワードなど）と kisui を入れるかの確認は窓に出す。
// 切れたら Session が自動でつなぎ直し、左の一覧の見出しに接続の状態を出す（丸・1 行・ボタン）。
// つながらない・別の GUI に引き継がれた（C7）ときは右下に知らせ、ボタンでつなぎ直せるようにする（connect/Notices.tsx）。
// 左にはつないだマシンごとの見出しとワークスペースの帯を出し、帯を押すとフォーカスを移す（D1）。
// フォーカスしているワークスペースの帯の下にはツリーを出す。開閉とスクロールの位置はワークスペースごとに覚え、
// フォーカスを外して戻しても残す（D2）。マシンごとに色を決めて覚え、見出しと帯の左端の線に使う（D4）。
// マシンの見出しの [+] でフォルダ未定のワークスペースを作り（フォルダはプライマリターミナルで cd すると決まる）、帯の [×] で閉じる
// （プログラムが動いていれば、先に確認の窓を出す）。ターミナルはワークスペースごとにあり、帯を押してフォーカスを移すと、
// 右の欄のターミナルもそのワークスペースのものに切り替わる（F2）。
// 右の欄には、フォーカスしているワークスペースのターミナル（先頭がプライマリ）を、kisui serve が持つ分割の木の通りに並べる。編集はプライマリの欄の中の shj が受け持つ。
// Cmd+D・Ctrl+Shift+D（右）と Cmd+Shift+D・Ctrl+Shift+E（下）で今の欄を分けて増やし、分割したターミナルの `exit` で閉じて並び直し、リーダーの h j k l で隣へ移る（キーは commands.ts の表）（F4。terminal/group.ts・
// terminal/grid.ts）。プライマリターミナルは `exit` しても閉じず、Enter で作り直す。
// 新しい版があれば右下に知らせ、押されたら入れ替えて起動し直す（C8。update/UpdateBar.tsx）。
// 窓と知らせは、どれもモック Connect.dc.html のカードの決まりで描く（connect/card.css）。
import { T } from "./i18n/index.ts";
import {
  batch,
  createEffect,
  on,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type JSX,
  untrack,
} from "solid-js";

import { AskpassDialog } from "./AskpassDialog.tsx";
import {
  explorerRow,
  isLeaveExplorerKey,
  startFocusStep,
} from "./explorerFocus.ts";
import { focusWorkspaceAndTerminal } from "./focusWorkspaceAndTerminal.ts";
import { afterChangesKey } from "./changes/handover.ts";
import { changesRow } from "./changes/keys.ts";
import { ClipboardDialog } from "./ClipboardDialog.tsx";
import {
  ClipboardHistoryDialog,
  openClipboardHistory,
} from "./ClipboardHistoryDialog.tsx";
import { TransferDialog } from "./TransferDialog.tsx";
import { AddMachine } from "./connect/AddMachine.tsx";
import { ConfigError } from "./connect/ConfigError.tsx";
import { CloseWorkspaceCard } from "./connect/CloseWorkspaceCard.tsx";
import { InstallCard } from "./connect/InstallCard.tsx";
import { MachineDialog } from "./connect/MachineDialog.tsx";
import { MascotDialog } from "./MascotDialog.tsx";
import { chooseMascot, reloadCurrent, type Failure } from "./mascotStore.ts";
import { machineRows } from "./connect/machineList.ts";
import { Notices, type Notice } from "./connect/Notices.tsx";
import { RenameDialog } from "./connect/RenameDialog.tsx";
import {
  describeClient,
  handoverFailure,
  statusLine,
  type MachineStatus,
} from "./connect/status.ts";
import { UpdateBar } from "./update/UpdateBar.tsx";
import {
  checkNow,
  dismissUpdate,
  installUpdate,
  updateInfo,
} from "./update/store.ts";
import { OsClipboard } from "./clipboard.ts";
import { CopiedToast, copiedNotice, showToast } from "./CopiedToast.tsx";
import { ScaleToast, showScale } from "./ScaleToast.tsx";
import { copyAndNotify } from "./copiedNotice.ts";
import {
  applyMove,
  CHANGES_BORDER,
  KEY_STEP,
  loadSidebarOpen,
  loadSizes,
  resizeAction,
  resizeKeyName,
  saveSidebarOpen,
  saveSizes,
  SPLIT_KEY_STEP,
  sizeOf,
  withoutSize,
  withSize,
  type Border,
  type PaneSizes,
} from "./panes.ts";
import { ErrorCode, RpcError } from "./rpc/message.ts";
import type {
  ChangesShjKey,
  ExtraPane,
  PrimaryShj,
  SplitDir,
  Workspace,
  WorkspaceId,
} from "./rpc/protocol.ts";
import {
  adoptFocus,
  band,
  buildSidebar,
  unsetTitle,
  gwsRows,
  health,
  type Row,
  isBrowserOnly,
  keepFocus,
  shouldSendMoveTo,
  type WorkspaceFocus,
  stepFrom,
  stepWorkspace,
  type Step,
} from "./sidebar/model.ts";
import { MACHINE_COLORS, machineColors } from "./sidebar/colors.ts";
import { loadOrder } from "./sidebar/order.ts";
import {
  addBrowser,
  addBrowserWorkspace,
  addTerm,
  autoName,
  nameErrorText,
  addWorkspace,
  after,
  browserKey,
  cycleKey,
  displayName,
  dropTerm,
  EMPTY_GWS,
  gwsOfBrowser,
  gwsOfTerm,
  loadGws,
  move as moveGws,
  moveBefore,
  moveTabBefore,
  moveTabStep,
  newGwsId,
  steppableTabs,
  visibleTabs,
  reconcile,
  refKey,
  removeBrowser,
  rename as renameGws,
  renameBrowser,
  repTerm,
  saveGws,
  setActiveTerm,
  shownBrowserId,
  termKey,
  termsOf,
  toggleFold,
  type Gws,
  type GwsState,
  type Lists,
  type TabRef,
} from "./gws/model.ts";
import { MachinePicker } from "./connect/MachinePicker.tsx";
import { WorkspaceKindPicker } from "./connect/WorkspaceKindPicker.tsx";
import { creatableRows } from "./connect/machineList.ts";
import { Sidebar, type NewTabKind } from "./sidebar/Sidebar.tsx";
import "./app.css";
import { LOCAL, type AskpassRequest, type ShellApi } from "./ssh/api.ts";
import {
  addMachine,
  browserStore,
  labelOf as machineLabelOf,
  loadMachines,
  mergeMachines,
  recordToSave,
  removeMachine,
  renameMachine,
  saveMachines,
  type KeyValueStore,
  type ConfigMachine,
  type Machine,
} from "./ssh/machines.ts";
import { Session, type SessionState } from "./ssh/session.ts";
import { tauriShell } from "./ssh/tauri.ts";
import { changeRows, changeErrorText, changesBaseOf } from "./changes/model.ts";
import {
  relativeIn,
  openErrorText,
  rows as treeRows,
  type TreeRow,
} from "./tree/model.ts";
import {
  absolutePath,
  newEntryDefault,
  newEntryPath,
  parentPath,
  renamedPath,
  type TreeMenuAction,
} from "./tree/menu.ts";
import { DeleteDialog, NameDialog } from "./tree/TreeDialogs.tsx";
import { WorkspaceTrees } from "./tree/trees.ts";
import {
  afterKeyUp,
  IDLE,
  interceptKeys,
  leaderKeyName,
  route,
  setBrowserEnabled,
  setUserShortcuts,
  type Command,
  type RouterState,
} from "./commands.ts";
import { BookmarkDialog } from "./browser/BookmarkDialog.tsx";
import {
  chromeTreeFromLoaded,
  countChrome,
  type ChromeNode,
} from "./browser/bookmarkTree.ts";
import {
  addBookmark,
  chromeProblemFromLoaded,
  type ChromeProblem,
  chromeProblemKey,
  fromLoaded as bookmarksFromLoaded,
  removeBookmark,
  type Bookmark,
} from "./browser/bookmarks.ts";
import { BrowserArea } from "./browser/BrowserArea.tsx";
import { FindBar } from "./browser/FindBar.tsx";
import {
  closeTabView,
  goTab,
  loadBookmarks,
  loadChromeBookmarks,
  loadTabs,
  navTab,
  onDownload,
  onTabClosed,
  onTabKey,
  onTabPage,
  onTabPopup,
  onTabTitle,
  onTabFavicon,
  openDownload,
  openTabDevtools,
  resolveTabUrl,
  revealDownload,
  saveBookmarks,
  saveTabs,
  zoomTab,
  type DownloadDone,
  type TabPopup,
} from "./browser/browserOs.ts";
import {
  addRelayed,
  relayedOf,
  unrelay,
  type Relayed,
} from "./browser/relay.ts";
import {
  addTab,
  closeTab,
  EMPTY_TABS,
  fromStored,
  newTabId,
  shownTab,
  showTab,
  toStored,
  updateTab,
  type BrowserTab,
  type TabsState,
} from "./browser/tabs.ts";
import { UrlBar } from "./browser/UrlBar.tsx";
import { isNewTab, NEW_TAB_URL } from "./browser/newTab.ts";
import { NewTabPage } from "./browser/NewTabPage.tsx";
import type { KeyLike } from "./guiKeys.ts";
import { closeTarget, IS_MAC } from "./guiKeys.ts";
import { KeyListDialog, openKeyList } from "./KeyListDialog.tsx";
import { placeOf } from "./placeKeys.ts";
import { LeaderMenu, leaderPath, setLeaderPath } from "./LeaderMenu.tsx";
import { loadScale, nextScale, saveScale, type ScaleAction } from "./scale.ts";
import { applyScale } from "./scaleOs.ts";
import type { Direction } from "./terminal/grid.ts";
import { focusLastNotified } from "./terminal/lastNotified.ts";
import type { UrlClick } from "coneko-term";
import { TermGroup, TermGroups } from "./terminal/group.ts";
import type { MediaFetch } from "./terminal/media.ts";
import { TerminalGrid } from "./terminal/TerminalGrid.tsx";
import { openUrlExternally } from "./terminal/openUrlOs.ts";
import { isOpenableUrl, urlClickAction } from "./terminal/urlOpen.ts";

/**
 * 起動したら、先に手元の設定ファイルの [[gui.machines]] を読む。間違いがあれば、場所・行・理由だけを出して、ほかは何もしない
 * （どこにもつながない）。読めたら本体（Workbench）を出す。
 */
export function App(props: {
  api?: ShellApi;
  /** 足したマシンなどの記録の置き場。省くと localStorage */
  store?: KeyValueStore;
}): JSX.Element {
  const api = props.api ?? tauriShell;
  const [loaded, setLoaded] = createSignal<
    | {
        config: ConfigMachine[];
        browser: boolean;
        shortcutProblems: string[];
        passkeyRejected: string[];
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
          // passkey_sites の公開サフィックスの項目（使わない）。内蔵ブラウザを使うときだけ知らせる
          passkeyRejected: g.browser ? g.passkeyRejected : [],
        });
      },
      (e) => setLoaded({ error: String(e) }),
    );
  });
  return (
    <Show when={loaded()}>
      {(l) => {
        const v = l();
        return "error" in v ? (
          <ConfigError message={v.error} />
        ) : (
          <Workbench
            api={api}
            store={props.store}
            config={v.config}
            browser={v.browser}
            shortcutProblems={v.shortcutProblems}
            passkeyRejected={v.passkeyRejected}
          />
        );
      }}
    </Show>
  );
}

function Workbench(props: {
  api: ShellApi;
  store?: KeyValueStore;
  /** 手元の設定ファイルで決めたマシン */
  config: ConfigMachine[];
  /** 内蔵ブラウザのタブを使うか（設定の [gui.browser] enabled。#202） */
  browser?: boolean;
  /** 設定の [gui.shortcuts] の間違い（あればお知らせに出す） */
  shortcutProblems?: string[];
  /** 設定の [gui.browser] passkey_sites の、公開サフィックスなので使わない項目（あればお知らせに出す） */
  passkeyRejected?: string[];
}): JSX.Element {
  const api = props.api;
  const store = props.store ?? browserStore();
  // ~/.ssh/config のホスト（マシンを足すときの候補）
  const [hosts, setHosts] = createSignal<string[]>([]);
  // 足したマシン（サイドバーには、これと「ローカル」だけを出す）
  // GUI で足したマシンの記録（設定ファイルと重なって出ていないものも含む）
  let saved = loadMachines(store);
  // 設定ファイルのマシン（fixed）が先、そのあとに足したマシン
  const [machines, setMachines] = createSignal<Machine[]>(
    mergeMachines(props.config, saved),
  );
  const targets = createMemo(() => [LOCAL, ...machines().map((m) => m.target)]);
  const labelOf = (t: string) => machineLabelOf(machines(), t);
  const fixedOf = (t: string) =>
    machines().some((m) => m.target === t && m.fixed);
  function updateMachines(next: Machine[]) {
    setMachines(next);
    saved = recordToSave(next, saved, props.config);
    saveMachines(store, saved);
  }
  const [sessions, setSessions] = createSignal<Record<string, Session>>({});
  const [states, setStates] = createSignal<Record<string, SessionState>>({});
  const [workspaces, setWorkspaces] = createSignal<Record<string, Workspace[]>>(
    {},
  );
  // GUI のフォーカスは 1 つ（どのマシンの、どのワークスペースか）
  const [focus, setFocus] = createSignal<WorkspaceFocus | null>(null);
  // ワークスペースに移れなかった・ファイルを開けなかったときの知らせ（見出しと本文）。無ければ null
  const [focusError, setFocusError] = createSignal<{
    title: string;
    error: string;
  } | null>(null);
  let focusSeq = 0;
  /** workspace.focus の返事を待っている（ワークスペースを移している途中） */
  let switching = false;
  /**
   * フォーカスしているワークスペースを閉じている途中の、移り先（閉じたものの隣）。
   * 一覧から消えた知らせ（workspace.changed）と shj のフォーカスが外れた知らせは閉じる返事より先に届くので、
   * そこでフォーカスを一度 null にせず、すぐこの移り先にする（サイドバーが一瞬フォーカス無しで描かれるのを防ぐ）
   */
  let closingNext: WorkspaceFocus | null = null;
  let openSeq = 0;
  const offStates = new Map<string, () => void>();
  /** つないで最初の一覧を見たマシン（空なら自動でワークスペースを作る。作るのは 1 回だけ） */
  const started = new Set<string>();
  // マシンごと・ワークスペースごとのターミナル（F1・F4）。フォーカスしているワークスペースのものを出す。
  // 並びが変わったら termVersion を進める（TermGroup は signal ではない）
  const termGroups = new Map<string, TermGroups>();
  const [termVersion, setTermVersion] = createSignal(0);
  const termTarget = () => focus()?.target;
  const termGroup = (): TermGroup | undefined => {
    void termVersion();
    const f = focus();
    return f && sessions()[f.target]
      ? termGroups.get(f.target)?.get(f.id)
      : undefined;
  };
  const termList = () => termGroup()?.list ?? [];
  // プライマリ以外の欄を隠しているワークスペース（マシンとワークスペースの組）。GUI だけで持つ。隠した欄のターミナルは止めない
  const [zoomedWs, setZoomedWs] = createSignal<
    ReadonlyMap<string, { target: string; id: WorkspaceId }>
  >(new Map());
  const wsKey = (target: string, id: WorkspaceId) =>
    JSON.stringify([target, id]);
  /** そのワークスペースのプライマリで shj が動いているか */
  const primaryShjOn = (target: string, id: WorkspaceId) =>
    !!workspaces()[target]?.find((w) => w.id === id)?.primaryShj;
  const zoomed = () => {
    const f = focus();
    return (
      !!f &&
      zoomedWs().has(wsKey(f.target, f.id)) &&
      primaryShjOn(f.target, f.id)
    );
  };
  // プライマリの shj が終わったら（#549 の primaryShj が null）、隠していた欄を出す
  createEffect(() => {
    void workspaces();
    const cur = untrack(zoomedWs);
    const keep = [...cur].filter(([, v]) => primaryShjOn(v.target, v.id));
    if (keep.length !== cur.size) setZoomedWs(new Map(keep));
  });
  /**
   * ワークスペース（target, id）のプライマリ以外の欄を隠す・戻す。プライマリで shj が動いていなければ何もしない。
   * 隠すときはプライマリを使う欄にする。そのワークスペースにフォーカスしているときだけ、キーを向け直す。
   */
  function zoomWs(
    target: string,
    id: WorkspaceId,
    on: boolean | "toggle",
  ): boolean {
    if (!primaryShjOn(target, id)) return false;
    const k = wsKey(target, id);
    const was = zoomedWs().has(k);
    const want = on === "toggle" ? !was : on;
    if (want === was) return want;
    const next = new Map(zoomedWs());
    if (want) {
      next.set(k, { target, id });
      termGroups.get(target)?.get(id)?.setActive(0);
    } else next.delete(k);
    setZoomedWs(next);
    const f = untrack(focus);
    if (f && f.target === target && f.id === id) focusTerminal();
    return want;
  }
  /** フォーカスしているワークスペースで zoomWs する（Ctrl+Shift+M）。 */
  function setZoom(on: boolean | "toggle" = "toggle"): boolean {
    const f = focus();
    return f ? zoomWs(f.target, f.id, on) : false;
  }
  /** shj が端末のコマンドで欄を出した（muxBackend の show・split）。隠していれば戻し、その欄にキーを向ける。 */
  function paneShow(target: string, id: WorkspaceId, termId: string) {
    zoomWs(target, id, false);
    termGroups.get(target)?.get(id)?.activate(termId);
    const f = untrack(focus);
    if (f && f.target === target && f.id === id) focusTerminal();
  }
  /** shj の Space e：フォーカスしているワークスペースなら、サイドバーのファイルツリーにキーを向ける。 */
  function focusExplorer(target: string, id: WorkspaceId) {
    const f = untrack(focus);
    if (!f || f.target !== target || f.id !== id) return;
    focusInSidebar(() => explorerRow(nav));
  }
  /**
   * サイドバーの中の行（ツリー・CHANGES）にキーを向ける。閉じているサイドバーは、先に開く（隠れたままでは、キーの行き先が見えない）。
   * 開いた直後は画面（display）がまだ変わっていないことがあるので、向けるのは画面が変わったあとにする。
   */
  function focusInSidebar(rowOf: () => HTMLElement | null | undefined) {
    const go = () => {
      const row = rowOf();
      row?.focus();
      row?.scrollIntoView({ block: "nearest" });
    };
    if (untrack(sidebarOpen)) go();
    else {
      changeSidebarOpen(true);
      queueMicrotask(go);
    }
  }
  /**
   * shj が引数なしで起動した直後の、ツリーへのフォーカスの頼み（explorer.focus の start）。
   * 起動した直後は、ツリーの行がまだ届いていなかったり、cd したフォルダへの切り替え（1 秒おきに見る）でツリーが
   * 捨てられて取り直されたりする。そこで頼みを少しのあいだ覚え、ツリーの行が描かれるたびに、ツリーにキーが無ければ向け直す。
   * キーを打った・押した・別のワークスペースに移った・時間が過ぎたら捨てる。
   */
  let startFocus: { target: string; id: WorkspaceId; off: () => void } | null =
    null;
  function cancelStartFocus() {
    startFocus?.off();
    startFocus = null;
  }
  function requestStartFocus(target: string, id: WorkspaceId) {
    const f = untrack(focus);
    if (!f || f.target !== target || f.id !== id) return;
    // 閉じているサイドバーは、起動した直後の自動のフォーカスでは開かない（開けるのは、利用者がツリーへ移る操作だけ）
    if (!untrack(sidebarOpen)) return;
    cancelStartFocus();
    const cancel = () => cancelStartFocus();
    window.addEventListener("keydown", cancel, true);
    window.addEventListener("pointerdown", cancel, true);
    const timer = window.setTimeout(cancel, 3000);
    startFocus = {
      target,
      id,
      off: () => {
        window.removeEventListener("keydown", cancel, true);
        window.removeEventListener("pointerdown", cancel, true);
        window.clearTimeout(timer);
      },
    };
    retryStartFocus();
  }
  function retryStartFocus() {
    const p = startFocus;
    if (!p) return;
    const f = untrack(focus);
    const step = startFocusStep({
      stillFocused: !!f && f.target === p.target && f.id === p.id,
      sidebarOpen: untrack(sidebarOpen),
      keyInTree: !!nav?.contains(document.activeElement),
      hasRow: explorerRow(nav) !== null,
    });
    if (step === "drop") cancelStartFocus();
    else if (step === "focus") focusExplorer(p.target, p.id);
  }
  createEffect(() => {
    treeVersion();
    workspaces();
    focus();
    untrack(retryStartFocus);
  });
  onCleanup(cancelStartFocus);
  /** shj の Space E・cmd.diffchanges：フォーカスしているワークスペースなら、サイドバーの CHANGES にキーを向ける。 */
  function focusChanges(target: string, id: WorkspaceId) {
    const f = untrack(focus);
    if (!f || f.target !== target || f.id !== id) return;
    focusInSidebar(() => changesRow(nav));
  }
  const termActive = () => termGroup()?.active;
  const termExtras = () => termGroup()?.extras ?? [];
  const termLayout = () => termGroup()?.layout;
  const termActiveExtra = () => termGroup()?.activeExtra;
  // shj が動画などの欄を出した回数（ツリーで押したファイルの返事で、動画の欄から奪い返さないため）
  let extraShown = 0;
  /** shj が動画の欄を出した（#555）。隠していれば戻し、その欄にキーを向ける。 */
  function paneShowExtra(target: string, id: WorkspaceId, extraId: string) {
    extraShown++;
    zoomWs(target, id, false);
    termGroups.get(target)?.get(id)?.activateExtra(extraId);
    const f = untrack(focus);
    if (!f || f.target !== target || f.id !== id) return;
    focusTerminal();
  }
  // マシンごとのツリー（D2）。中身は WorkspaceTrees が持ち、変わったら treeVersion を進めて描き直す
  const trees = new Map<string, WorkspaceTrees>();
  const [treeVersion, setTreeVersion] = createSignal(0);
  const clipboard = new OsClipboard(
    () => navigator.clipboard,
    (e) => console.warn("clipboard:", e),
  );
  let nav: HTMLElement | undefined;
  let mainEl: HTMLDivElement | undefined;
  let appEl: HTMLElement | undefined;
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
      if (nav?.contains(document.activeElement)) focusTerminal();
      changeSidebarOpen(false);
      return;
    }
    changeSidebarOpen(true);
    // display: none の間にスクロールの位置は 0 に戻るので、今のワークスペースで覚えている位置に戻す
    restoreTreeScroll();
  }
  /** 今のワークスペースのツリーで覚えている位置に、サイドバーのスクロールを戻す（描き直しのあと）。 */
  function restoreTreeScroll() {
    const f = untrack(focus);
    const top = f ? trees.get(f.target)?.get(f.id)?.scrollTop : undefined;
    if (top !== undefined)
      requestAnimationFrame(() => {
        if (nav) nav.scrollTop = top;
      });
  }
  // リサイズモード（Cmd+R / Ctrl+Shift+R・パレットの「リサイズ」）か。境界を動かすキーは GUI が受ける
  const [resizeMode, setResizeMode] = createSignal(false);
  let focusActiveTerminal: (() => void) | undefined;
  // リサイズモードで動かす境界（光らせる）。ドラッグ中の境界も光る
  const [dragging, setDragging] = createSignal<Border | null>(null);
  // リサイズモードで動かしている境界：サイドバー（null）か、欄どうしの境界（grid.ts の key）。入るたびにサイドバーから始める
  const [resizeSel, setResizeSel] = createSignal<string | null>(null);
  createEffect(
    on(resizeMode, (m) => {
      if (!m) setResizeSel(null);
    }),
  );
  // 隠している間（zoomed）はつまみが出ないので、境界も無いものとする
  const termBars = () => (zoomed() ? [] : (termGroup()?.bars ?? []));
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
  const lit = (b: Border) =>
    dragging() === b ||
    (b === "changes"
      ? litChanges()
      : resizeMode() && litSplit() === undefined && !litChanges());
  const [asks, setAsks] = createSignal<AskpassRequest[]>([]);
  // マシンのダイアログ（リーダーの m）を出しているか
  const [machinesOpen, setMachinesOpen] = createSignal(false);
  /** キャラクターを選ぶ窓（リーダーの c s）を出しているか */
  const [mascotPicking, setMascotPicking] = createSignal(false);
  // リモートを足す窓を出しているか。足すためにつないでいる最中のマシン、足せなかった理由
  const [adding, setAdding] = createSignal(false);
  const [addPending, setAddPending] = createSignal<Machine | null>(null);
  const [addError, setAddError] = createSignal<string | undefined>();
  // 名前を変える窓を出しているマシン、変えられなかった理由
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [renameError, setRenameError] = createSignal<string | undefined>();
  // 名前をその場で変えている帯の GUI のワークスペース（current はつけている名前、auto は空にしたときの名前）、変えられなかった理由
  const [renamingWs, setRenamingWs] = createSignal<{
    gws: string;
    current: string;
    auto: string;
  } | null>(null);
  // 名前を変えているブラウザのタブ（窓で変える。リーダーの o R）
  const [renamingTab, setRenamingTab] = createSignal<string | null>(null);
  const [tabRenameError, setTabRenameError] = createSignal<
    string | undefined
  >();
  const [wsRenameError, setWsRenameError] = createSignal<string | undefined>();
  // 右下の知らせのうち、閉じたもの（状態が変われば、また出す）
  const [dismissed, setDismissed] = createSignal<ReadonlySet<SessionState>>(
    new Set(),
  );
  // 「あと何秒」を動かす
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 1000);

  // await の後は Owner が無いので、onCleanup は先に登録する
  const offs: (() => void)[] = [];
  // 表示の大きさ（#594）。覚えておいた大きさで始める
  let scale = loadScale(store);
  if (scale !== 1) void applyScale(scale);
  // w j / w k / w h / w l で続けて移っている間か（リーダーを閉じるまで）。この間はファイルツリーと CHANGES を出さず、
  // 1 つ移るごとにサイドバーが伸び縮みしないようにする（#140）
  const [walking, setWalking] = createSignal(false);
  // ツリーを出し直したら、そのワークスペースで覚えている位置に戻す（出していない間は、スクロールの位置が合わない）
  createEffect(
    on(walking, (w, prev) => {
      if (w || !prev) return;
      restoreTreeScroll();
    }),
  );
  // リーダー（Cmd+K / Ctrl+Shift+K）の状態。入っている間は、次に押せるキーの一覧を出す（LeaderMenu）
  let router: RouterState = IDLE;
  const setRouter = (next: RouterState) => {
    if (next.leader !== router.leader) setLeaderPath(next.leader, next.escaped);
    // リーダーを閉じたら、続けて移る間は出さずにいたファイルツリーを、行き先のワークスペースの分だけ出す
    if (!next.leader) setWalking(false);
    const left = router.leader !== null && next.leader === null;
    router = next;
    // ページから入ったリーダーを出たら、ページにキーを戻す（内蔵ブラウザ）
    if (left && pageReturn !== undefined) returnToPageLater();
  };
  // GUI が受けるキーなので、欄やターミナルに届く前（capture）に取って、shj にもシェルにも送らない。
  // 何を受けるかは、コマンドの表（commands.ts）が決める。リーダーに入っていないときは、その表のキーに当たるものだけを受け、
  // ほかのキーは今までどおりターミナル（shj やシェル）に届く
  const onGuiKey = (e: KeyboardEvent) => {
    // 隣へ移るのは、ターミナルを並べていて、キーがターミナルに向いているときだけ
    const card = mainEl?.querySelector(":scope > .terminal");
    const routed = route(router, e, {
      mac: IS_MAC,
      dialogOpen: !!document.querySelector("dialog[open]"),
      resizeMode: resizeMode(),
      // Cmd+W（Mac）は、キーがターミナルの欄（画像・動画・PDF の欄を含む）に向いているときか、どこにも向いていないときに、
      // 今の欄だけを閉じる。どちらでも、アプリの窓は閉じない（#83）
      inPane:
        !shownBrowserTab() &&
        closeTarget(e.target, card, !!termGroup()) === "pane",
      // 内蔵ブラウザのタブを出している間は、Cmd+R / Ctrl+Shift+R を読み込み直しにする
      browser: !!shownBrowserTab(),
    });
    setRouter(routed.state);
    if (routed.consume) {
      e.preventDefault();
      e.stopPropagation();
      if (routed.run && (!e.repeat || routed.repeat)) runCommand(routed.run);
      return;
    }
    // リサイズモード（#526）：キーは境界を動かすのに使い、ターミナルには送らない。入るのは Cmd+R / Ctrl+Shift+R（Alt+R は端末に渡す）
    const rname = e.isComposing ? null : resizeKeyName(e, IS_MAC);
    if (rname && resizeMode()) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat || resizeAction(rname).kind !== "exit") resizeKey(rname);
      return;
    }
    // ファイルツリーから端末へ戻る（Esc・Ctrl+E）。メニューや窓の中の Esc には触らない
    if (
      isLeaveExplorerKey(e) &&
      e.target instanceof Element &&
      nav?.contains(e.target) &&
      e.target.closest(".tree-row")
    ) {
      e.preventDefault();
      e.stopPropagation();
      focusTerminal();
    }
  };
  const onGuiKeyUp = () => setRouter(afterKeyUp(router));
  // 窓を離れたり、画面を押したりしたら、リーダーを出る（キーが向く先が変わるため）
  const leaveLeader = () => {
    if (router.leader) setRouter(IDLE);
  };
  window.addEventListener("keydown", onGuiKey, true);
  window.addEventListener("keyup", onGuiKeyUp, true);
  window.addEventListener("blur", leaveLeader);
  window.addEventListener("pointerdown", leaveLeader, true);
  onCleanup(() => {
    window.removeEventListener("keydown", onGuiKey, true);
    window.removeEventListener("keyup", onGuiKeyUp, true);
    window.removeEventListener("blur", leaveLeader);
    window.removeEventListener("pointerdown", leaveLeader, true);
    clearInterval(tick);
    offs.forEach((f) => f());
    for (const s of Object.values(sessions())) void s.close();
  });
  onMount(async () => {
    const found = await api.listSshHosts().catch(() => []);
    setHosts(found);
    offs.push(
      await api.onAskpass((e) => setAsks((a) => [...a, e])),
      await api.onAskpassDone((id) =>
        setAsks((a) => a.filter((x) => x.requestId !== id)),
      ),
    );
    // Mac のメニューの「閉じる」（Cmd+W）。PDF の欄の中を押した後は、キーが画面に届かないので、ここで受ける（#111）。
    // キーが画面に届くときは、onGuiKey が先に受けて止めるので、ここには来ない
    if (api.onCloseRequest) {
      offs.push(
        await api.onCloseRequest(() => {
          // 内蔵ブラウザのタブを出している間は、見えないペインも窓も閉じない
          if (untrack(shownBrowserTab)) return;
          const card = mainEl?.querySelector(":scope > .terminal");
          if (
            closeTarget(document.activeElement, card, !!termGroup()) === "pane"
          ) {
            runCommand({ id: "pane.close" });
          } else {
            void api.windowClose?.();
          }
        }),
      );
    }
    // 質問の窓口を用意してから、「ローカル」と足したマシンにつなぐ
    for (const t of targets()) connect(t);
  });

  /** マシンごとの shj のフォーカス（GUI のフォーカスが外れたときの代わりの候補）。 */
  function shjFocuses(): Record<string, WorkspaceId | null> {
    return Object.fromEntries(
      Object.entries(sessions()).map(([t, s]) => [t, s.focus]),
    );
  }

  /** マシンの状態の 1 行（サイドバーの見出しの下と、マシンのダイアログ）。 */
  function statusOf(t: string): MachineStatus {
    return sessions()[t]
      ? statusLine(states()[t], now())
      : { text: T("status.disconnected"), title: "", retry: "again" };
  }

  function connect(target: string) {
    const old = sessions()[target];
    if (old) {
      if (old.state.kind === "failed" || old.state.kind === "superseded") {
        old.retry();
        return;
      }
      return; // つないでいる最中、またはつながっている
    }
    const s = new Session(api, target);
    const tr = new WorkspaceTrees({
      request: (method, params) => s.request(method, params),
      onChange: () => setTreeVersion((v) => v + 1),
      onError: (m) => console.warn(`[${target}] ${m}`),
    });
    trees.set(target, tr);
    const group = new TermGroups(
      s,
      () => setTermVersion((v) => v + 1),
      (m) => console.warn(`[${target}] ${m}`),
    );
    termGroups.set(target, group);
    const offTerm = s.onTerm((e) => group.handle(e));
    const off = s.onState((st) => {
      // つなぎ直したら、ターミナルの溜めた出力を続きから取り直す（右下に出す前なら何もしない）
      if (st.kind === "connected") group.reconnected();
      setStates((m) => ({ ...m, [target]: st }));
      // つなぎ直したら、今のワークスペースのツリーと git の印を取り直す
      if (st.kind === "connected") tr.reconnected();
    });
    const offTree = s.onTreeChanged((n) => tr.handleTreeChanged(n));
    const offGit = s.onGitChanged((n) => tr.handleGitChanged(n));
    const offWs = s.onWorkspaces((ws) => {
      tr.retain(ws.map((w) => w.id));
      // プライマリターミナルで cd してフォルダが切り替わったワークスペースは、ツリーを捨てて取り直す
      for (const w of ws) {
        const before = workspaces()[target]?.find((x) => x.id === w.id);
        if (before && before.folder !== w.folder) tr.reset(w.id);
      }
      group.sync(ws);
      // 一覧とフォーカスは一緒に変える（別々だと、消えたワークスペースにフォーカスしたままの一覧が一度描かれる）
      batch(() => {
        setWorkspaces((m) => ({ ...m, [target]: ws }));
        setFocus((f) => keepFocus(f, workspaces(), shjFocuses(), closingNext));
      });
      // つないで最初に分かった一覧が空なら、ワークスペースを 1 つ作る（何も無い画面から始めない）。
      // 閉じて空になったときは作らない
      if (!started.has(target) && s.state.kind === "connected") {
        started.add(target);
        // 内蔵ブラウザを使っていて、ブラウザのタブだけのワークスペースがあれば、そこに居られるので作らない
        // （ブラウザのタブを読み終えたら、そこへ移る。下の effect）
        if (ws.length === 0) {
          if (
            props.browser &&
            untrack(gws).list.some((g) => termsOf(g).length === 0)
          )
            setLanding(target);
          else void createWorkspace(target);
        }
      }
    });
    const offFocus = s.onFocus((id) =>
      setFocus((f) =>
        keepFocus(
          adoptFocus(f, target, id),
          workspaces(),
          shjFocuses(),
          closingNext,
        ),
      ),
    );
    const offPane = s.onPane((ev) => {
      if (ev.kind === "show") paneShow(target, ev.workspaceId, ev.termId);
      else if (ev.kind === "show-extra")
        paneShowExtra(target, ev.workspaceId, ev.extraId);
      else if (ev.kind === "explorer") {
        if (ev.start) requestStartFocus(target, ev.workspaceId);
        else focusExplorer(target, ev.workspaceId);
      } else if (ev.kind === "changes") focusChanges(target, ev.workspaceId);
      else if (ev.kind === "open-url")
        openUrlFor(target, ev.url, ev.workspaceId);
      else if (ev.kind === "update-check")
        void checkNow().then((r) => s.reportUpdate(ev.id, r));
      else zoomWs(target, ev.workspaceId, true);
    });
    offStates.set(target, () => {
      offTerm();
      off();
      offTree();
      offGit();
      offWs();
      offFocus();
      offPane();
    });
    setSessions((m) => ({ ...m, [target]: s }));
    setStates((m) => ({ ...m, [target]: s.state }));
    s.start();
  }

  async function disconnect(target: string) {
    const s = sessions()[target];
    if (!s) return;
    offStates.get(target)?.(); // close() の closed を一覧に書き戻させない
    offStates.delete(target);
    trees.delete(target);
    termGroups.delete(target); // シェルは止めない（ワークスペースは shj に残る）
    started.delete(target);
    setSessions(({ [target]: _, ...rest }) => rest);
    setStates(({ [target]: _, ...rest }) => rest);
    setWorkspaces(({ [target]: _, ...rest }) => rest);
    setFocus((f) => keepFocus(f, workspaces(), shjFocuses()));
    await s.close();
  }

  /** 今の窓で効く境界の上限（app.css の clamp・changes.css の max-height と同じ）。 */
  function maxOf(b: Border = "sidebar"): number {
    return b === "changes"
      ? Math.min(640, window.innerHeight / 2)
      : Math.min(640, window.innerWidth / 2);
  }

  /** 画面に出ている CHANGES の一覧の高さ。一覧が無ければ undefined。 */
  function shownChangesHeight(): number | undefined {
    return appEl
      ?.querySelector<HTMLElement>(".changes-list")
      ?.getBoundingClientRect().height;
  }

  /** sizes の changes を、画面に出ている一覧の高さにしたもの（出ていなければそのまま）。 */
  function withShownHeight(s: PaneSizes): PaneSizes {
    const h = shownChangesHeight();
    return h === undefined ? s : withSize(s, "changes", h, maxOf("changes"));
  }

  /** リサイズモードで key（TUI と同じ名前。panes.ts）を押した。 */
  function resizeKey(key: string) {
    const a = resizeAction(key);
    switch (a.kind) {
      case "nudge": {
        // ファイルツリーと CHANGES の境目は上下だけ動かす（上へ動かすと CHANGES が高くなる）
        if (litChanges()) {
          if (a.axis === "y")
            changeSizes(
              applyMove(
                // 動かし始めは、画面に出ている一覧の高さ（行が少なく、覚えた値より低いとき、見えない値だけが動かないように）
                withShownHeight(sizes()),
                "changes",
                -a.sign * KEY_STEP.changes,
                maxOf("changes"),
              ),
            );
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
        // サイドバーの幅、ファイルツリーと CHANGES の境目（CHANGES が出ているとき）、ペインどうしの境界（木の順）の順に回す
        const order: (string | null)[] = [
          null,
          ...(changesShown() ? [CHANGES_BORDER] : []),
          ...termBars().map((b) => b.key),
        ];
        const cur = litChanges() ? CHANGES_BORDER : (litSplit() ?? null);
        const i = order.indexOf(cur);
        setResizeSel(order[(i + a.step + order.length) % order.length]);
        break;
      }
      case "reset": {
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
    const box = appEl;
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

  /** ワークスペースのフォルダ。フォルダ未定なら null、ワークスペースが分からなければ undefined。 */
  function folderOf(
    target: string,
    id: WorkspaceId,
  ): string | null | undefined {
    return workspaces()[target]?.find((w) => w.id === id)?.folder;
  }

  /** ワークスペースのフォルダ（未定・分からなければ undefined）。 */
  function rootOf(target: string, id: WorkspaceId): string | undefined {
    return folderOf(target, id) ?? undefined;
  }

  /**
   * shj のフォーカスを GUI のフォーカスに合わせ直す（食い違うと、そのワークスペースのファイルや CHANGES の操作が無視される）。
   * GUI のフォーカスのマシンへ、今のワークスペースを workspace.focus で送り直す。送るのは、
   * inFlightTo を渡したときは、それ（捨てた移動の行き先のマシン）が GUI のフォーカスのマシンのとき
   * （返事がまだなので、shj のフォーカスは知っているものと違わない）。渡さないときは、知っている shj のフォーカスが違うとき。
   */
  function resyncShjFocus(inFlightTo?: string) {
    const f = focus();
    const fs = f ? sessions()[f.target] : undefined;
    if (!f || !fs) return;
    if (inFlightTo !== undefined ? inFlightTo !== f.target : fs.focus === f.id)
      return;
    void fs.focusWorkspace(f.id).catch(() => {});
  }

  /** 帯を押した。shj に workspace.focus を送り、受け付けられたら GUI のフォーカスも移す。 */
  async function focusWorkspace(target: string, id: WorkspaceId) {
    const s = sessions()[target];
    if (!s) return;
    const seq = ++focusSeq; // 続けて押したら、最後に押したものだけを使う
    setFocusError(null);
    switching = true;
    try {
      await s.focusWorkspace(id);
      if (seq !== focusSeq) return;
      switching = false;
      // 右下のターミナルは、そのワークスペースのものに切り替わる（F2。termGroup が focus から決める）
      batch(() => {
        setTermless(null);
        setFocus({ target, id });
      });
    } catch (e) {
      if (seq !== focusSeq) return;
      switching = false;
      // フォーカスしているワークスペースを閉じた返事を待つあいだに押して失敗した、など
      resyncShjFocus();
      setFocusError({
        title: T("err.workspace.focus", { machine: labelOf(target) }),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * 帯を押す・キーでワークスペースを移る。移れたら、そこで最後に使っていたペインにキーを向ける（#151）。
   * 帯を押すとキーがサイドバー（WebKit では body）に移るので、向け直さないと戻っても打てない。
   */
  function switchWorkspace(target: string, id: WorkspaceId) {
    // マシンにつながっていないタブは移れない。つなぎ直す案内を出す（タブは並びに残してある）
    if (!sessions()[target] || states()[target]?.kind !== "connected") {
      cannot(
        T("err.workspace.focus", { machine: labelOf(target) }),
        T("cannot.tab.disconnected", { machine: labelOf(target) }),
      );
      return Promise.resolve();
    }
    return focusWorkspaceAndTerminal(
      { focusWorkspace, current: focus, focusTerminal },
      target,
      id,
    );
  }

  /**
   * 見出しの [+]。フォルダ未定のワークスペースを作ってフォーカスし、プライマリターミナルにキーを向ける。
   * フォルダは、そのターミナルで cd すると決まる。
   */
  function createWorkspace(target: string) {
    // 新しいワークスペースは、ターミナルのタブ 1 つを持って、並びの一番下に入る
    return createMachineWorkspace(target, "err.workspace.create", (id) =>
      setGws((g) => addWorkspace(g, target, id)),
    );
  }

  /**
   * マシンにワークスペース（ターミナルのタブ）を 1 つ作り、place で GUI の記録に入れ、フォーカスして、ターミナルにキーを向ける。
   * 記録には、マシンの一覧の知らせより先に入れてよい（二重には入らない）。作れなければ errKey の題で理由を伝える。
   * ワークスペースを作る（w n）・ターミナルのタブを足す（「+」・t n）の共通の部分。dir があれば、そのフォルダでシェルを始める。
   */
  async function createMachineWorkspace(
    target: string,
    errKey: "err.workspace.create" | "err.tab.add",
    place: (id: WorkspaceId) => void,
    dir?: string,
  ) {
    const s = sessions()[target];
    if (!s) return;
    setFocusError(null);
    try {
      const { id } = await s.createWorkspace(dir);
      // 一覧の知らせが返事より先に届いていれば、整理はもう済んでいて印を外す機会が来ない。守る必要もないので印を付けない
      if (!untrack(workspaces)[target]?.some((w) => w.id === id))
        justCreated.add(termKey(target, id));
      place(id);
      await focusWorkspace(target, id);
      if (focus()?.id === id) focusTerminal();
    } catch (e) {
      setFocusError({
        title: T(errKey, { machine: labelOf(target) }),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * 閉じる処理 close を、移り先 moveTo（フォーカスしているものを閉じるときの隣。無ければ null）つきで動かす。
   * 移り先は閉じる前に決めておき、一覧から消えた知らせを受けたところで（返事を待たずに）フォーカスを移す。
   * プログラムが動いていて断られたら（force でないとき）onRunning を呼び、ほかの失敗は name を添えて伝える。
   * 閉じられたら、GUI のフォーカスはもう移っているので shj にも移り先を伝える
   * （待つあいだにユーザーが別の帯を選んだ・移り先も消えた、なら伝えない。押した帯の返事を待っている途中（switching）なら、その返事に任せる）。
   * ワークスペースを閉じる（✕）・ターミナルのタブを閉じる（✕）の共通の部分。
   */
  async function closeThenMove(
    moveTo: WorkspaceFocus | null,
    name: string,
    force: boolean,
    close: () => Promise<void>,
    onRunning: () => void,
    /** 閉じられたあとに動かす（移り先がターミナルのタブでないとき、そこへ移る） */
    onClosed?: () => void,
  ) {
    setFocusError(null);
    // 移り先が無いとき（フォーカスしていないものを閉じる）は、先に閉じ始めたものの移り先を消さない
    if (moveTo) closingNext = moveTo;
    try {
      await close();
    } catch (e) {
      if (moveTo && closingNext === moveTo) closingNext = null;
      const d =
        e instanceof RpcError && e.code === ErrorCode.Busy
          ? (e.data as { reason?: string } | undefined)
          : undefined;
      if (d?.reason === "running" && !force) {
        onRunning();
        return;
      }
      setFocusError({
        title: T("err.workspace.close", { name }),
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (moveTo && closingNext === moveTo) closingNext = null;
    if (moveTo && !switching && shouldSendMoveTo(focus(), moveTo, workspaces()))
      void focusWorkspace(moveTo.target, moveTo.id);
    onClosed?.();
  }

  // 閉じる前に確認している（プログラムが動いている）ワークスペース
  const [confirmClose, setConfirmClose] = createSignal<{
    gws: string;
    name: string;
  } | null>(null);

  /**
   * 帯の [×]。GUI のワークスペースを閉じる：中のターミナルのタブ（マシンのワークスペース）のターミナルを全部終わらせ、ブラウザのタブも閉じる。
   * プログラムが動いていれば断られるので、確認の窓を出す（force は窓で「終わらせて閉じる」を押したとき。残りのタブは窓の後に続ける）。
   * マシンにつながっていないタブは、閉じられないので記録から外すだけ（マシンのワークスペースは残り、つながったらまた新しいワークスペースになる）。
   * フォーカスしているワークスペースを閉じたら、隣のワークスペースに移る。
   */
  async function closeWorkspace(gid: string, force = false) {
    const g = untrack(gws).list.find((x) => x.id === gid);
    if (!g) return;
    // 閉じたあとの移り先は、サイドバーの 1 列で隣のワークスペース（マシンが違ってもよい）
    const list = rows();
    const i = list.findIndex((r) => r.gws === gid);
    const next = list[i + 1] ?? list[i - 1];
    const wasCurrent = currentGws()?.id === gid;
    const name = displayName(g);
    // ターミナルのタブにフォーカスしていて、移り先もターミナルのタブなら、moveTo で移る（shj にも伝える）。
    // ターミナルのタブを持たないワークスペースに居たとき・移り先がそうなときは、閉じたあとに goRow で移る
    const fromTerm = termsOf(g).length > 0;
    const moveTo =
      wasCurrent && fromTerm && next && !isBrowserOnly(next)
        ? { target: next.target, id: next.band.id }
        : null;
    await closeThenMove(
      moveTo,
      name,
      force,
      async () => {
        for (const r of termsOf(g)) {
          const s = sessions()[r.target];
          if (!s || states()[r.target]?.kind !== "connected") {
            setGws(dropTerm(untrack(gws), r.target, r.ws));
            continue;
          }
          await s.closeWorkspace(r.ws, force);
        }
        // ブラウザのタブも閉じる（ターミナルのタブが全部閉じたあとに）
        for (const r of g.tabs) if (r.kind === "browser") dropBrowserTab(r.id);
      },
      () => setConfirmClose({ gws: gid, name }),
      () => {
        if (wasCurrent && next && !moveTo) goRow(next);
      },
    );
  }

  /** ブラウザのタブを、ページも記録もまとめて閉じる（出すタブの移り先は決めない）。 */
  function dropBrowserTab(id: string) {
    void closeTabView(id).catch(() => {});
    setTabs((t) => closeTab(t, id));
    setGws((x) => removeBrowser(x, id));
  }

  // 初めて出たマシンには色を割り当てて保存する（つなぐマシンが変わったときだけ計算し直す）
  const colors = createMemo(() => machineColors(store, targets()));
  const groups = createMemo(() =>
    buildSidebar(
      targets(),
      states(),
      workspaces(),
      focus(),
      colors(),
      labelOf,
      fixedOf,
    ),
  );

  // ---- GUI のワークスペース（#231）----
  // ワークスペースは手元の GUI が持つ。中のターミナルのタブは、各マシンの kisui serve のワークスペース 1 つずつ。
  // 名前・並び・中のタブは webview の localStorage に覚える（gws/model.ts）。
  // 内蔵ブラウザのタブ（#202）は GUI のワークスペースに属する。タブの中身と、ワークスペースごとに何を出しているかは tabs に持つ
  const [tabs, setTabsState] = createSignal<TabsState>(EMPTY_TABS);
  /** 覚えていたブラウザのタブを読み終えたか（読む前の空のまま、ワークスペースの記録からブラウザのタブを外さないため） */
  const [tabsReady, setTabsReady] = createSignal(false);
  const [gws, setGwsState] = createSignal<GwsState>(
    loadGws(store) ?? EMPTY_GWS,
  );
  function setGws(next: GwsState | ((g: GwsState) => GwsState)) {
    const before = untrack(gws);
    const v = typeof next === "function" ? next(before) : next;
    if (v === before) return;
    setGwsState(v);
    saveGws(store, v);
  }
  /** 前の並び順の記録（w J・w K）。初めてワークスペースを作るときの並びに使う */
  const legacyOrder = loadOrder(store);
  /**
   * いま居るのが、ターミナルのタブを持たないワークスペース（ブラウザのタブだけのもの。#257）なら、その id。
   * このときも focus（ターミナルのタブのフォーカス）は、最後にフォーカスしていたターミナルのタブのまま残る（隠れているだけ）。
   * ターミナルのタブへ移ったら（focusWorkspace）消える
   */
  const [termless, setTermless] = createSignal<string | null>(null);
  /** GUI がフォーカスしているワークスペース */
  const currentGws = () => {
    const t = termless();
    if (t !== null) {
      const g = gws().list.find((x) => x.id === t);
      if (g && termsOf(g).length === 0) return g;
    }
    const f = focus();
    return f ? gwsOfTerm(gws(), f.target, f.id) : undefined;
  };
  /**
   * 起動したとき、ターミナルのタブが無くて、ブラウザのタブだけのワークスペースへ入る待ち（値は、ワークスペースを作るはずだったマシン）。
   * ブラウザのタブを読み終えても、ブラウザのタブだけのワークスペースが残らなければ（記録が読めなかった・消えていた）、そのマシンにワークスペースを作る
   */
  const [landing, setLanding] = createSignal<string | null>(null);
  createEffect(() => {
    const target = landing();
    if (target === null) return;
    if (currentGws()) {
      setLanding(null);
      return;
    }
    // ブラウザのタブを読み終えるまでは、行が無い。読めたら、最初のブラウザのタブだけのワークスペースへ移る
    const r = rows().find(isBrowserOnly);
    if (r) {
      setLanding(null);
      untrack(() => showGws(r.gws));
    } else if (
      tabsReady() &&
      !gws().list.some((g) => termsOf(g).length === 0)
    ) {
      setLanding(null);
      untrack(() => void createWorkspace(target));
    }
  });
  /** ターミナルのタブを持たないワークスペースへ移る（そのワークスペースのブラウザのタブのページにキーを向ける）。 */
  function showGws(gid: string) {
    setTermless(gid);
    focusTerminal();
  }
  /** サイドバーの行 r のワークスペースへ移る。ターミナルのタブがあればそのタブ、無ければブラウザのタブのページ。 */
  function goRow(r: Row) {
    if (isBrowserOnly(r)) showGws(r.gws);
    else void switchWorkspace(r.target, r.band.id);
  }
  /** 作ったばかりで、マシンの一覧の知らせがまだ届いていないターミナルのタブ（termKey）。reconcile が外さない */
  const justCreated = new Set<string>();
  const rows = createMemo(() =>
    gwsRows(gws(), {
      groups: groups(),
      workspaces: workspaces(),
      focus: focus(),
      current: currentGws()?.id ?? "",
      browser: new Map(tabs().tabs.map((t) => [t.id, t])),
      views: tabs().views,
      labelOf,
      colorOf: (t) => colors()[t] ?? MACHINE_COLORS[0],
      healthOf: (t) => health(states()[t]),
    }),
  );
  // マシンの一覧・ブラウザのタブに、ワークスペースの記録を合わせる（reconcile）
  createEffect(() => {
    const lists: Lists = {};
    for (const [t, ws] of Object.entries(workspaces()))
      if (states()[t]?.kind === "connected")
        lists[t] = ws.map((w) => ({ id: w.id, title: band(w, false).title }));
    const browser = props.browser && tabsReady() ? tabs().tabs : undefined;
    const r = reconcile(untrack(gws), {
      lists,
      browser,
      legacyOrder,
      keep: justCreated,
    });
    setGws(r.state);
    // 一覧に載ったら、もう守らなくてよい
    for (const [t, l] of Object.entries(lists))
      for (const w of l ?? []) justCreated.delete(termKey(t, w.id));
    // 持ち主のワークスペースが無くなったブラウザのタブも閉じる
    for (const id of r.close) {
      void closeTabView(id).catch(() => {});
      setTabs((t) => closeTab(t, id));
    }
  });
  // 最後に使っていたターミナルのタブを覚える
  createEffect(() => {
    const f = focus();
    if (f) setGws((g) => setActiveTerm(g, f.target, f.id));
  });

  // フォーカスしているワークスペースのツリーだけを動かし（監視と取り直し）、
  // 前にそのワークスペースで覚えたスクロールの位置に戻す（D2）
  // フォルダ未定のワークスペースにはツリーが無いので、監視も取り直しもしない
  const treeFocus = createMemo(
    () => {
      const f = focus();
      return f && folderOf(f.target, f.id) !== null ? f : null;
    },
    null,
    { equals: (a, b) => a?.target === b?.target && a?.id === b?.id },
  );
  createEffect(() => {
    const f = treeFocus();
    Object.keys(sessions()); // つないだマシンが増えたら、その WorkspaceTrees にも伝える
    untrack(() => {
      let restore: number | undefined;
      for (const [t, tr] of trees) {
        const id = f?.target === t ? f.id : null;
        if (id !== null && id !== tr.activeId) restore = tr.get(id)?.scrollTop;
        tr.activate(id);
      }
      // 描き直し（ツリーの入れ替え）のあとで戻す。初めてのワークスペースは今の位置のまま
      if (restore !== undefined) {
        const top = restore;
        requestAnimationFrame(() => {
          if (nav) nav.scrollTop = top;
        });
      }
    });
  });

  function rememberScroll() {
    if (untrack(walking)) return; // ツリーを出していない間の位置は、ツリーのものではない
    const f = focus();
    if (f && nav) trees.get(f.target)?.setScroll(f.id, nav.scrollTop);
  }

  function treeOf(target: string, id: WorkspaceId) {
    if (walking()) return undefined;
    treeVersion();
    const s = trees.get(target)?.get(id);
    return s && s.listings[""] ? treeRows(s) : undefined;
  }

  /**
   * ツリー・CHANGES の行を押した。プライマリの shj に method（shj.open か shj.diff）を送り、通ったらプライマリのターミナルにキーを向ける。
   * ready は、その shj が受けられる状態か（ツリーはプライマリで shj が動いているときだけ、CHANGES は差分モードのときだけ出すので、そうでなければ何もしない）。
   * 断られたら、帯を押して移れなかったときと同じ所に title と errorText の文を出す。
   * ワークスペースを移している途中は送らない（フォーカスを移した先のワークスペースのプライマリで開くため）。
   */
  function askPrimaryShj(
    method: "shj.open" | "shj.diff",
    target: string,
    id: WorkspaceId,
    path: string,
    ready: (shj: PrimaryShj | null | undefined) => boolean,
    title: string,
    errorText: (path: string, e: unknown) => string,
  ) {
    const s = sessions()[target];
    if (!s || switching || s.focus !== id) return;
    if (!ready(workspaces()[target]?.find((w) => w.id === id)?.primaryShj))
      return;
    const seq = ++openSeq; // 続けて押したら、最後に押したものの失敗だけを出す
    setFocusError(null);
    const shown = extraShown;
    s.request(method, { workspaceId: id, path }).then(
      () => {
        // 返事を待つあいだに別のワークスペースへ移っていたら、そちらのターミナルは動かさない
        if (seq !== openSeq || s.focus !== id) return;
        // 動画だった（shj が動画の欄を出して、そこにキーを向けた）なら、プライマリに奪い返さない
        if (extraShown !== shown) return;
        termGroup()?.setActive(0); // 0 番目がプライマリ
        focusTerminal();
      },
      (e) => {
        if (seq !== openSeq) return;
        setFocusError({ title, error: errorText(path, e) });
      },
    );
  }

  /** ツリーのファイルの行を押した（shj.open）。 */
  const openFile = (target: string, id: WorkspaceId, path: string) =>
    askPrimaryShj(
      "shj.open",
      target,
      id,
      path,
      (shj) => !!shj,
      T("err.file.open"),
      openErrorText,
    );

  /** CHANGES の行を押した（shj.diff。path は shj が知らせた絶対パス）。 */
  const openChange = (target: string, id: WorkspaceId, path: string) =>
    askPrimaryShj(
      "shj.diff",
      target,
      id,
      path,
      (shj) => !!shj?.diff,
      T("err.diff.show"),
      changeErrorText,
    );

  /**
   * CHANGES で押した shj のキー（s・r・R・Space・:）を、shj に「CHANGES で押した」ものとして渡す。
   * s・r・R は一覧にフォーカスを残す。Space と : は、通ってからプライマリのターミナルにキーを向ける（handover.ts。先に向けると続きのキーが先に届く）。
   */
  function changesShjKey(target: string, id: WorkspaceId, key: ChangesShjKey) {
    const s = sessions()[target];
    if (!s || switching || s.focus !== id) return;
    setFocusError(null);
    afterChangesKey(
      key,
      s.request("shj.changesKey", { workspaceId: id, key }),
      {
        toTerminal: () => {
          if (s.focus !== id) return;
          termGroup()?.setActive(0); // 0 番目がプライマリ
          focusTerminal();
        },
        fail: (e) =>
          setFocusError({
            title: T("err.changes.op"),
            error: e instanceof Error ? e.message : String(e),
          }),
      },
    );
  }

  // ツリーの右クリックのメニューから開いた窓（名前を入れる・削除の確認）
  const [treeDialog, setTreeDialog] = createSignal<{
    kind: "new-file" | "new-dir" | "rename" | "delete";
    target: string;
    id: WorkspaceId;
    /** 新規は入れるフォルダ、名前の変更と削除は対象（ルートからの相対パス。ルートは ""） */
    path: string;
    dir: boolean;
  } | null>(null);

  /** OS のクリップボードに入れ、書けたときだけ「コピーしました」を出す。 */
  async function copyToClipboard(text: string) {
    await copyAndNotify(
      () => clipboard.write(text),
      () => copiedNotice.show(),
    );
  }

  /** ツリーの行のメニューで項目を選んだ。コピーと cd はすぐ、新規・名前の変更・削除は窓を出す。 */
  function treeAction(
    target: string,
    id: WorkspaceId,
    row: TreeRow,
    action: TreeMenuAction,
  ) {
    const root = rootOf(target, id);
    if (root === undefined) return;
    switch (action) {
      case "copy-name":
        void copyToClipboard(row.name);
        break;
      case "copy-relative":
        void copyToClipboard(row.path);
        break;
      case "copy-absolute":
        void copyToClipboard(absolutePath(root, row.path));
        break;
      case "cd":
        void sendCd(target, id, absolutePath(root, row.path));
        break;
      case "new-file":
      case "new-dir":
        // メニューはフォルダの行にだけ出す。キー（a・A）はファイルの行でも使え、そのファイルのフォルダに作る（shj のツリーと同じ）
        setTreeDialog({
          kind: action,
          target,
          id,
          path: row.dir ? row.path : parentPath(row.path),
          dir: true,
        });
        break;
      case "rename":
      case "delete":
        setTreeDialog({
          kind: action,
          target,
          id,
          path: row.path,
          dir: row.dir,
        });
        break;
    }
  }

  /**
   * ワークスペースのプライマリターミナルに cd を送る。フォルダ（ワークスペースの root）は
   * そのシェルの cwd で決まるので、シェルが cd すればツリーも切り替わる。
   */
  async function sendCd(target: string, id: WorkspaceId, path: string) {
    const s = sessions()[target];
    const term = workspaces()[target]?.find((w) => w.id === id)?.primary;
    if (!s || !term) return;
    setFocusError(null);
    try {
      await s.request("term.cd", { termId: term, path });
    } catch (e) {
      const running =
        e instanceof RpcError &&
        e.code === ErrorCode.Busy &&
        (e.data as { reason?: string } | undefined)?.reason === "running";
      setFocusError({
        title: T("err.cd.send"),
        error: running
          ? T("err.cd.running")
          : e instanceof Error
            ? e.message
            : String(e),
      });
    }
  }

  /** 名前を入れる窓で決めた。断られたら例外を投げる（窓が理由を出す）。 */
  async function submitTreeName(value: string) {
    const d = treeDialog();
    const s = d && sessions()[d.target];
    if (!d || !s) return;
    if (d.kind === "rename") {
      const to = renamedPath(d.path, value);
      if (to !== null) {
        await s.request("tree.rename", {
          workspaceId: d.id,
          from: d.path,
          to,
        });
      }
    } else {
      const path = newEntryPath(value, d.kind === "new-file" ? "file" : "dir");
      if (path !== null) {
        const kind = d.kind === "new-file" ? "file" : "dir";
        await s.request("tree.create", { workspaceId: d.id, path, kind });
        // 閉じているフォルダに作ったら開いて、できたものが見えるようにする
        const t = trees.get(d.target);
        const ws = t?.get(d.id);
        const parent = parentPath(path);
        if (parent !== "" && ws && !ws.expanded[parent])
          t?.toggle(d.id, parent);
        // TUI のツリーの a と同じく、作ったファイルはそのまま開く
        if (kind === "file") openFile(d.target, d.id, path);
      }
    }
    setTreeDialog(null);
  }

  /** 削除の確認で「削除する」を押した。断られたら例外を投げる。 */
  async function submitTreeDelete() {
    const d = treeDialog();
    const s = d && sessions()[d.target];
    if (!d || !s) return;
    await s.request("tree.delete", { workspaceId: d.id, path: d.path });
    setTreeDialog(null);
  }

  /** 差分モードの CHANGES の一覧。フォーカスしているワークスペースの、差分モードのプライマリの shj のものだけ。 */
  function changesOf(target: string, id: WorkspaceId) {
    if (walking()) return undefined;
    const f = focus();
    if (f?.target !== target || f.id !== id) return undefined;
    const diff = workspaces()[target]?.find((x) => x.id === id)?.primaryShj
      ?.diff;
    return diff
      ? {
          rows: changeRows(diff, rootOf(target, id)),
          base: changesBaseOf(diff),
        }
      : undefined;
  }

  /** サイドバーに CHANGES が出ているか（ファイルツリーとの境目を動かせるか）。サイドバーを閉じている間は出ていない。 */
  function changesShown(): boolean {
    const f = focus();
    return (
      sidebarOpen() && f !== null && changesOf(f.target, f.id) !== undefined
    );
  }

  /** プライマリの shj が出しているファイル（ツリーで強調する行）。 */
  function currentOf(target: string, id: WorkspaceId) {
    const f = focus();
    if (f?.target !== target || f.id !== id) return undefined;
    const w = workspaces()[target]?.find((x) => x.id === id);
    return relativeIn(w?.primaryShj?.file, rootOf(target, id));
  }

  /** フォーカスしているワークスペースの、ターミナルでない欄（動画）の中身を取る関数。 */
  function readExtra(pane: ExtraPane): MediaFetch {
    const f = focus();
    const s = f ? sessions()[f.target] : undefined;
    const workspaceId = f?.id;
    return async (p) => {
      if (!s || workspaceId === undefined)
        throw new Error(T("status.disconnected"));
      return s.request("media.read", { workspaceId, id: pane.id, ...p });
    };
  }

  /**
   * URL を開く。`ws` を渡し、内蔵ブラウザを有効にしていれば（#203）、そのワークスペースの新しいタブで開く。
   * そうでなければ手元の外部ブラウザで開く。どちらも、リモートのマシンの localhost 系は、殻が `kisui relay` の中継越しに開く（#96・#127）。
   */
  function openUrlFor(target: string, url: string, ws?: WorkspaceId) {
    if (!isOpenableUrl(url)) return;
    if (props.browser && ws !== undefined) {
      openInNewTab(target, ws, url);
      return;
    }
    openUrlExternally(target, url).catch((e: unknown) =>
      setFocusError({
        title: T("err.url.open"),
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }

  /**
   * ターミナルの URL がクリックされた（#47）。cmd（macOS 以外は ctrl）を押していなければ何もしない。
   * cmd + クリックは、内蔵ブラウザを有効にしていれば今のワークスペースの新しいタブ、無効なら手元の外部ブラウザで開く（#203）。
   * cmd + option + クリック（macOS 以外は ctrl + alt）は、いつも外部ブラウザで開く。shift は付けても同じ。
   * 開くのは http と https の URL だけ。
   */
  function openUrl(click: UrlClick) {
    const action = urlClickAction(click, IS_MAC);
    if (!isOpenableUrl(click.url) || action === null) return;
    const f = focus();
    if (f)
      openUrlFor(f.target, click.url, action === "open" ? f.id : undefined);
  }

  /**
   * 今使っているターミナルの欄にキーを向ける。今のワークスペースで内蔵ブラウザのタブを出していれば、そのページに向ける。
   */
  function focusTerminal() {
    if (untrack(shownBrowserTab)) {
      focusBrowserPage?.();
      return;
    }
    // 足した欄のターミナルが開くのを待つ（作ったばかりのワークスペースは、欄が描かれるまでもう少しかかる）
    const focus = () => focusActiveTerminal?.();
    queueMicrotask(() => {
      focus();
      if (!mainEl?.contains(document.activeElement))
        requestAnimationFrame(() => requestAnimationFrame(focus));
    });
  }

  /** 今の欄を右・下・左・上に分けてターミナルを足し、キーを向ける（Cmd+D・Ctrl+Shift+D など。F4）。フォーカスしているワークスペースに属する。 */
  function newTerminal(dir: SplitDir) {
    // 隠している欄があれば先に戻す（足した欄が見えないままになるため）
    setZoom(false);
    // フォルダは shj が決める（ワークスペースのフォルダ。未定なら start_dir）
    void termGroup()
      ?.add(dir)
      .then((added) => {
        if (added) focusTerminal();
      });
  }

  // ---- 内蔵ブラウザのタブ（#202。設定の [gui.browser] enabled で有効にしたときだけ）----
  // タブは GUI のワークスペースに属し、サイドバーのワークスペースの帯の下に、ターミナルのタブと一緒に並ぶ（#231）。タブを選ぶと、グリッドの場所すべてがそのページになる。
  // 開いていたタブは殻がデータのフォルダに覚え、再起動したら戻す（browser/tabs.ts・browser.rs）
  /** 覚えていたタブを読み終えたか（読む前に空のまま書いて、覚えていたものを消さないため） */
  let tabsLoaded = false;
  let saveTimer: number | undefined;
  function setTabs(next: TabsState | ((t: TabsState) => TabsState)) {
    const before = untrack(tabs);
    const v = typeof next === "function" ? next(before) : next;
    if (v === before) return;
    setTabsState(v);
    if (!tabsLoaded) return;
    // ページの遷移のたびに書かないよう、少し待ってまとめて書く
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void saveTabs(toStored(untrack(tabs))).catch((e: unknown) =>
        console.warn("browser tabs:", e),
      );
    }, 500);
  }
  /** 今のワークスペースで出しているブラウザのタブ。ターミナルのタブを出していれば undefined。 */
  const shownBrowserTab = createMemo(() => {
    const g = currentGws();
    if (!props.browser || !g) return undefined;
    const id = shownBrowserId(g, tabs().views[g.id], (x) =>
      tabs().tabs.some((t) => t.id === x),
    );
    return id === undefined ? undefined : tabs().tabs.find((t) => t.id === id);
  });
  /** 出しているタブのうち、ページを開いているもの（URL バーを出す）と、新しいタブのページ（#238。NewTabPage を出す）の id */
  const pageTabId = createMemo(() => {
    const t = shownBrowserTab();
    return t && !isNewTab(t) ? t.id : undefined;
  });
  const newTabPageId = createMemo(() => {
    const t = shownBrowserTab();
    return t && isNewTab(t) ? t.id : undefined;
  });
  let focusBrowserPage: (() => void) | undefined;
  /**
   * タブ → これまで使った中継の origin と元の origin（リモートのマシンの localhost 系を `kisui relay` の中継で開いたタブだけ。#203）。
   * タブは元の URL を覚えて入力欄に出し、ページから届く中継の URL は元の URL に戻してから書く（browser/relay.ts）。
   * 戻る・進むで前の中継の URL に戻ることもあるので、対応は足すだけにし、捨てるのはタブを閉じたときだけ
   */
  const relays = new Map<string, readonly Relayed[]>();
  /** タブ tab で url を開くときに、ページに実際に開かせる URL を得て、中継の対応を覚える。 */
  async function resolveFor(
    tab: Pick<BrowserTab, "id" | "target">,
    url: string,
  ): Promise<string> {
    const opened = await resolveTabUrl(tab.target, url);
    const r = relayedOf(url, opened);
    if (r) relays.set(tab.id, addRelayed(relays.get(tab.id) ?? [], r));
    return opened;
  }
  // 閉じたタブの対応を捨てる
  createEffect(() => {
    const alive = new Set(tabs().tabs.map((t) => t.id));
    for (const id of [...relays.keys()]) if (!alive.has(id)) relays.delete(id);
  });
  /**
   * URL をワークスペースの新しいタブで開く（`kisui open`・shj の URL を開く要求・ターミナルの URL のクリック。#203）。
   * リモートのマシンの localhost 系は、先に中継を用意する（そのポートで誰も待っていなければ、タブを作らずにそう出す。外部ブラウザと同じ）。
   * フォーカスしているワークスペースなら、そのページにキーを向ける。ほかのワークスペースなら、そこへは移らない
   * （そのワークスペースに移ると、タブのページが出ている）。
   */
  function openInNewTab(target: string, ws: WorkspaceId, url: string) {
    const tab: BrowserTab = {
      id: newTabId(),
      target,
      workspace: ws,
      url,
      title: "",
    };
    resolveFor(tab, url).then(
      () => {
        // 持ち主は、そのターミナルのタブがあるワークスペース（無ければ、分かったときに reconcile が入れる）
        const gid = gwsOfTerm(untrack(gws), target, ws)?.id;
        setTabs((s) => addTab(s, tab, gid));
        if (gid) setGws((g) => addBrowser(g, gid, tab.id));
        const f = untrack(focus);
        if (gid && f && gwsOfTerm(untrack(gws), f.target, f.id)?.id === gid)
          focusTerminal();
      },
      (e: unknown) =>
        setFocusError({
          title: T("err.url.open"),
          error: e instanceof Error ? e.message : String(e),
        }),
    );
  }
  /**
   * 新しいタブのページのタブを開く（リーダーの o n・o N と、「+」のメニューの「ブラウザ」。#238）。URL は聞かず、URL が空のタブ（newTab.ts）を
   * 足して出す。検索窓とブックマークの中身は NewTabPage が描く（出たら検索窓にキーがある）。今のタブの URL の書き換えは、ページの上の URL バー（#232）
   */
  function openNewTab(
    target: string,
    ws: WorkspaceId,
    incognito: boolean,
    owner?: string,
  ) {
    const id = newTabId();
    const gid = owner ?? gwsOfTerm(untrack(gws), target, ws)?.id;
    // ページから押したときに覚えた「戻す先」を捨てる（検索窓にキーを向けるのを、ページに戻させない。openFind と同じ）
    pageReturn = undefined;
    setTabs((s) =>
      addTab(
        s,
        {
          id,
          target,
          workspace: ws,
          url: NEW_TAB_URL,
          title: "",
          ...(incognito ? { incognito: true } : {}),
        },
        gid,
      ),
    );
    if (gid) setGws((g) => addBrowser(g, gid, id));
  }
  /**
   * ページにキーがあるときにリーダーか近道を押した（殻がキーをこの画面に移してから届く）。そのときの画面のキーの行き先。
   * 押した操作が終わって（リーダーなら出て）も、キーの行き先がそのままなら、ページにキーを戻す
   */
  let pageReturn: Element | null | undefined;
  function returnToPageLater() {
    setTimeout(() =>
      requestAnimationFrame(() => {
        if (pageReturn === undefined || router.leader) return;
        const was = pageReturn;
        pageReturn = undefined;
        if (
          !untrack(shownBrowserTab) ||
          untrack(resizeMode) ||
          document.querySelector("dialog[open]")
        )
          return;
        // 押した操作がキーをほかへ向けた（名前の入力欄・ファイルツリーなど）ときは、戻さない
        if (document.activeElement !== was) return;
        focusTerminal();
      }),
    );
  }
  /** ページにキーがあったときに押されたキー（リーダー・近道と、リーダーに入ったあと画面に移るまでのキー）。 */
  function onPageKey(e: KeyLike) {
    if (pageReturn === undefined) pageReturn = document.activeElement;
    const routed = route(router, e, {
      mac: IS_MAC,
      dialogOpen: !!document.querySelector("dialog[open]"),
      resizeMode: resizeMode(),
      // ページを出している間は、ペインに向いていないものとする（Cmd+W で、見えないペインを閉じない）
      inPane: false,
      browser: !!shownBrowserTab(),
    });
    setRouter(routed.state);
    if (routed.consume && routed.run && (!e.repeat || routed.repeat))
      runCommand(routed.run);
    returnToPageLater();
  }
  /**
   * ページが新しい窓（`target=_blank` のリンク・`window.open`）を開いた（#204）。殻はもう webview を作ってある。
   * 開いた元のタブと同じワークスペースの新しいタブにして出す（元がシークレットならシークレット。データは元と同じ）。
   * 元のタブがもう無ければ、webview を壊す。
   */
  function addPopupTab(e: TabPopup) {
    const from = untrack(tabs).tabs.find((t) => t.id === e.opener);
    // 足す前にページが閉じていた（window.open(...).close()。殻の知らせは「閉じた」が先に届きうる）なら、足さずに壊す
    if (!from || closedEarly.delete(e.tab)) {
      void closeTabView(e.tab).catch(() => {});
      return;
    }
    // 中継で開いているタブから開いたなら、中継の対応を引き継ぐ（同じ origin のページを開くことが多い）
    const r = relays.get(from.id);
    if (r) relays.set(e.tab, r);
    const tab: BrowserTab = {
      id: e.tab,
      target: from.target,
      workspace: from.workspace,
      url: unrelay(e.url, r),
      title: "",
      incognito: from.incognito,
      opener: from.id,
      made: true,
    };
    const gid = gwsOfBrowser(untrack(gws), from.id)?.id;
    setTabs((s) => addTab(s, tab, gid));
    if (gid) setGws((g) => addBrowser(g, gid, tab.id));
    if (gid && untrack(currentGws)?.id === gid) focusTerminal();
  }
  /**
   * まだ足していないタブの「閉じた」（ページが開いた新しい窓が、画面に知らせが届く前に閉じた）。あとで届く「新しいタブ」を足さない。
   * 知らないタブの知らせが積もらないよう、新しい 32 個だけ覚える
   */
  const closedEarly = new Set<string>();
  /** ページが自分を閉じた（`window.close()`。#204）。タブを閉じ、出していたなら開いた元のタブに戻る。 */
  function closedByPage(id: string) {
    const tab = untrack(tabs).tabs.find((t) => t.id === id);
    if (!tab) {
      closedEarly.add(id);
      for (const old of closedEarly) {
        if (closedEarly.size <= 32) break;
        closedEarly.delete(old);
      }
      return;
    }
    const shown = untrack(shownBrowserTab)?.id === id;
    removeTab(id, tab.opener);
    if (shown) focusTerminal();
  }

  /**
   * ブラウザのタブを閉じる。出していたタブなら、同じワークスペースの次のタブ（無ければ前のタブ）を出す
   * （ふつうのブラウザで、今のタブを閉じたときと同じ。ターミナルのタブも並びの中にある）。
   * back（同じワークスペースのブラウザのタブ）を渡すと、次のタブの代わりにそれを出す（ページが自分を閉じたときに、開いた元のタブへ戻る。#204）。
   */
  function removeTab(id: string, back?: string) {
    const g = gwsOfBrowser(untrack(gws), id);
    const next =
      g && shownIdOf(g) === id ? after(g, browserKey(id), back) : undefined;
    // ワークスペースの最後のタブなら、ワークスペースも閉じる。いま居るなら、サイドバーの隣のワークスペースへ移る
    const list = rows();
    const k = g ? list.findIndex((r) => r.gws === g.id) : -1;
    const last =
      !!g && g.tabs.length === 1 && untrack(currentGws)?.id === g.id
        ? (list[k + 1] ?? list[k - 1])
        : undefined;
    setTabs((s) => closeTab(s, id));
    setGws((x) => removeBrowser(x, id));
    if (g && next) activateTab(g.id, next);
    else if (last) goRow(last);
  }
  /** ワークスペース g が今出しているブラウザのタブの id（ターミナルのタブを出していれば undefined。ターミナルのタブが無いワークスペースは、出している・無ければ最初のブラウザのタブ）。 */
  function shownIdOf(g: Gws): string | undefined {
    const t = untrack(tabs);
    return shownBrowserId(g, t.views[g.id], (id) =>
      t.tabs.some((x) => x.id === id),
    );
  }

  /**
   * ワークスペース gid のタブ ref を出す。ブラウザのタブならそのページを、ターミナルのタブならそのターミナルのグリッドを。
   * ほかのワークスペースにいれば、そこへ移る（移るのは、そのワークスペースの今のターミナルのタブ。キーはそのタブに向く）。
   */
  function activateTab(gid: string, ref: TabRef) {
    const g = untrack(gws).list.find((x) => x.id === gid);
    if (!g) return;
    if (ref.kind === "browser") setTabs((s) => showTab(s, gid, ref.id));
    else setTabs((s) => showTab(s, gid, null));
    const f = untrack(focus);
    const inside = untrack(currentGws)?.id === gid;
    if (ref.kind === "term") void switchWorkspace(ref.target, ref.ws);
    else if (inside) focusTerminal();
    else {
      const t = repTerm(g, f, (m) => states()[m]?.kind === "connected");
      if (t) void switchWorkspace(t.target, t.ws);
      else showGws(gid);
    }
  }

  // ---- 内蔵ブラウザのブックマーク（#205）。すべてのワークスペースで共有し、殻がデータのフォルダに覚える ----
  /** ブックマーク（新しく足したものが先）。読み終えるまでは undefined */
  const [bookmarks, setBookmarks] = createSignal<Bookmark[] | undefined>();
  const [bookmarksFailed, setBookmarksFailed] = createSignal(false);
  /** Chrome のブックマークの木（#239。#275 でフォルダの入れ子のまま持つ。読むだけ。無い・読めないときは空） */
  const [chromeBookmarks, setChromeBookmarks] = createSignal<
    ChromeNode[] | undefined
  >();
  /** Chrome のブックマークの数（自身のものが読めなかったときの案内に使う） */
  const chromeCount = createMemo(() => countChrome(chromeBookmarks() ?? []));
  /** ブックマークの一覧のダイアログ（リーダーの o B）を出しているか */
  const [bookmarkDialog, setBookmarkDialog] = createSignal(false);
  /** 最後に知らせた、Chrome のブックマークを読めなかった理由（#265。同じ理由を開くたびに知らせない。読めたら忘れる） */
  let lastChromeProblem: string | undefined;
  /** Chrome のブックマークを読めなかった理由を、前に知らせたものと違うときだけお知らせに出す（#265。開くたびに読み直すので、続けては知らせない）。読めたら忘れる。 */
  function notifyChromeProblem(problem: ChromeProblem | undefined) {
    if (!problem) {
      lastChromeProblem = undefined;
      return;
    }
    const key = chromeProblemKey(problem);
    if (key === lastChromeProblem) return;
    lastChromeProblem = key;
    showToast(
      T(
        problem.needsPermission
          ? "err.bookmarks.chromePermission"
          : "err.bookmarks.chrome",
        { reason: problem.reason, path: problem.path },
      ),
    );
  }
  /** Chrome のブックマークを読み直す（#239。Chrome で足し・消しした分が反映される）。命令が失敗したときと、読めなかったとき（#265）は前のまま（無ければ空）。 */
  function readChromeBookmarks() {
    loadChromeBookmarks().then(
      (v) => {
        const first = untrack(chromeBookmarks) === undefined;
        const problem = chromeProblemFromLoaded(v);
        notifyChromeProblem(problem);
        const list = chromeTreeFromLoaded(v);
        if (!problem || first) setChromeBookmarks(list);
        // 自分のものの読み込みが先に失敗していたら、Chrome のものが届いたここで知らせる（読み終わる順に依らないように）
        if (first && countChrome(list) > 0 && untrack(bookmarksFailed))
          showToast(T("err.bookmarks.read"));
      },
      (e: unknown) => {
        console.warn("chrome bookmarks:", e);
        if (untrack(chromeBookmarks) === undefined) setChromeBookmarks([]);
      },
    );
  }
  /** 覚えているブックマークを読む（一覧を開くたびと、初めて足すとき。読めなければ前のまま）。 */
  function readBookmarks(): Promise<Bookmark[]> {
    return loadBookmarks().then(
      (v) => {
        const list = bookmarksFromLoaded(v);
        setBookmarks(list);
        setBookmarksFailed(false);
        return list;
      },
      (e: unknown) => {
        console.warn("bookmarks:", e);
        if (untrack(bookmarks) === undefined) setBookmarksFailed(true);
        // 一覧には Chrome のものが出るので、自分のものが読めなかったことは別に知らせる（#239）
        if (untrack(chromeCount) > 0) showToast(T("err.bookmarks.read"));
        throw e;
      },
    );
  }
  /**
   * ブックマークを書き換えて覚える。書けたら onSaved を呼ぶ。書けなければ前の一覧に戻して知らせる
   * （書けないものを一覧に残すと、画面とファイルが食い違い、その後の保存もすべて失敗するため）。
   */
  function changeBookmarks(next: Bookmark[], onSaved?: () => void) {
    const prev = untrack(bookmarks);
    setBookmarks(next);
    saveBookmarks(next).then(
      () => onSaved?.(),
      (e: unknown) => {
        // 書いている間に、ほかの操作がまた書き換えていれば、そちらを残す
        if (untrack(bookmarks) === next) setBookmarks(prev);
        setFocusError({
          title: T("err.bookmarks.save"),
          error: e instanceof Error ? e.message : String(e),
        });
      },
    );
  }
  /** 今のページをブックマークに足す（リーダーの o b）。読む前なら、先に読んでから足す（覚えていたものを消さないため）。 */
  function bookmarkPage(t: BrowserTab) {
    const add = (list: Bookmark[]) =>
      changeBookmarks(addBookmark(list, { url: t.url, title: t.title }), () =>
        showToast(T("toast.bookmarked")),
      );
    const had = bookmarks();
    if (had) add(had);
    else
      readBookmarks().then(add, (e: unknown) =>
        setFocusError({
          title: T("err.bookmarks.save"),
          error: e instanceof Error ? e.message : String(e),
        }),
      );
  }
  /** ブックマークを今のワークスペースの新しいタブで開く（一覧の Enter）。 */
  function openBookmark(b: Bookmark) {
    const f = focus();
    setBookmarkDialog(false);
    if (!f) {
      cannot(T("cannot.browser.open.title"), T("cannot.browser.open.text"));
      return;
    }
    setTabs((s) =>
      addTab(s, {
        id: newTabId(),
        target: f.target,
        workspace: f.id,
        url: b.url,
        title: b.title,
      }),
    );
    focusTerminal();
  }

  // 新しいタブのページ（#238）を出すたびに、ブックマークを読み直す（読めなければ、前に読んだものを出す）
  createEffect(
    on(newTabPageId, (id) => {
      if (id !== undefined) {
        readChromeBookmarks();
        readBookmarks().catch(() => {});
      }
    }),
  );

  // ---- 内蔵ブラウザのページ内検索（#205）。出しているタブの下の端に、検索の欄を出す ----
  /** 検索の欄を出しているタブ。無ければ null */
  const [findTab, setFindTab] = createSignal<string | null>(null);
  let focusFind: (() => void) | undefined;
  /** 検索の欄を開く。開いていれば、入力欄にキーを向ける。 */
  function openFind(t: BrowserTab) {
    // ページから押したときに覚えた「戻す先」を捨てる。ページを押した後も画面のキーの行き先は入力欄のまま残るので、
    // 捨てないと「行き先が変わっていない」と見て、キーをページに戻してしまう
    pageReturn = undefined;
    if (untrack(findTab) === t.id) focusFind?.();
    else setFindTab(t.id);
  }
  // ---- 内蔵ブラウザの URL バー（#232）。出しているタブのページの上の端 ----
  let focusUrlBar: (() => void) | undefined;
  /** URL バーで決めた。今のタブで開く。 */
  function submitUrlBar(tab: string, url: string) {
    // 中継を用意できてから（リモートのマシンの localhost 系）タブの URL を書き換える。用意できなければ、ページも URL も前のまま。
    // まだ作っていない・開けなかったタブは、BrowserArea が書き換えた URL で作る（goTab は失敗する）
    const t = untrack(tabs).tabs.find((x) => x.id === tab);
    if (t)
      resolveFor(t, url).then(
        (opened) => {
          setTabs((s) => updateTab(s, tab, { url }));
          void goTab(tab, opened).catch(() => {});
        },
        (e: unknown) =>
          setFocusError({
            title: T("err.page.open"),
            error: e instanceof Error ? e.message : String(e),
          }),
      );
    focusTerminal();
  }

  /** 検索の欄を閉じ、キーをページに戻す。 */
  function closeFind() {
    setFindTab(null);
    focusTerminal();
  }
  // 出すタブが替わったら（グリッドに戻った・ほかのタブへ）、検索の欄を閉じる
  createEffect(
    on(shownBrowserTab, (t) => {
      const open = untrack(findTab);
      if (open !== null && t?.id !== open) setFindTab(null);
    }),
  );

  /** ブラウザを出している間の表示の大きさ（リーダーの v のグループ。#205）。ページの表示の大きさを変え、タブに覚える。 */
  function changePageZoom(t: BrowserTab, a: ScaleAction) {
    const z = nextScale(t.zoom ?? 1, a);
    setTabs((s) => updateTab(s, t.id, { zoom: z === 1 ? undefined : z }));
    void zoomTab(t.id, z).catch(() => {});
    showScale(z);
  }

  // ---- 内蔵ブラウザのダウンロード（#204）。~/Downloads に保存し、右下のお知らせで知らせる ----
  /** 知らせているダウンロード（古い順。多すぎるときは古いものから消す） */
  const [downloads, setDownloads] = createSignal<DownloadDone[]>([]);
  function addDownload(d: DownloadDone) {
    setDownloads((l) => [...l, d].slice(-3));
  }
  const dropDownload = (d: DownloadDone) =>
    setDownloads((l) => l.filter((x) => x !== d));
  /** ダウンロードしたファイルを開く・フォルダを表示する。開けなければ知らせる。 */
  function useDownload(d: DownloadDone, how: "open" | "reveal") {
    (how === "open" ? openDownload(d.id) : revealDownload(d.id)).then(
      () => dropDownload(d),
      (e: unknown) =>
        setFocusError({
          title:
            how === "open"
              ? T("err.download.open", { name: d.name })
              : T("err.download.reveal", { name: d.name }),
          error: e instanceof Error ? e.message : String(e),
        }),
    );
  }
  /** いちばん新しい、保存できたダウンロード（リーダーの n o・n f が使う）。 */
  const lastDownload = () => [...downloads()].reverse().find((d) => d.ok);
  /** ダウンロード 1 つの知らせ（同じダウンロードには同じオブジェクトを返す）。 */
  const downloadNotices = new WeakMap<DownloadDone, Notice>();
  function downloadNotice(d: DownloadDone): Notice {
    const had = downloadNotices.get(d);
    if (had) return had;
    const close = { label: T("button.close"), run: () => dropDownload(d) };
    const leader = leaderKeyName(IS_MAC);
    const n: Notice = d.ok
      ? {
          title: T("download.done.title"),
          text: T("download.done.text", { name: d.name, dir: d.dir, leader }),
          secondary: [
            close,
            {
              label: T("download.reveal"),
              run: () => useDownload(d, "reveal"),
            },
          ],
          primary: {
            label: T("download.open"),
            run: () => useDownload(d, "open"),
          },
          dismiss: close.run,
        }
      : {
          title: T("download.failed.title"),
          text: d.name,
          primary: close,
          dismiss: close.run,
        };
    downloadNotices.set(d, n);
    return n;
  }

  if (props.browser) {
    onMount(async () => {
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
      offs.push(
        await onTabKey(onPageKey),
        await onTabPage((e) => {
          // 中継で開いているタブは、元の URL に戻して覚える（入力欄にも元の URL を出す）
          const url = unrelay(e.url, relays.get(e.tab));
          if (isOpenableUrl(url)) setTabs((t) => updateTab(t, e.tab, { url }));
          // 読み込み中は地球のアイコン（#237。読み込みが終われば、殻が新しいページの favicon を知らせる）
          if (e.loading)
            setTabs((t) => updateTab(t, e.tab, { favicon: undefined }));
        }),
        await onTabFavicon((e) =>
          setTabs((t) => updateTab(t, e.tab, { favicon: e.icon || undefined })),
        ),
        await onTabTitle((e) =>
          setTabs((t) => updateTab(t, e.tab, { title: e.title })),
        ),
        await onTabPopup(addPopupTab),
        await onTabClosed((e) => closedByPage(e.tab)),
        await onDownload(addDownload),
      );
    });
    // リサイズモードを出たら、ページにキーを戻す
    createEffect(
      on(resizeMode, (m, prev) => {
        if (prev && !m && untrack(shownBrowserTab)) focusTerminal();
      }),
    );
    onCleanup(() => window.clearTimeout(saveTimer));
  }

  /** 今のワークスペースで出しているタブ。無ければ「できない」と知らせて undefined。 */
  function currentTab() {
    const t = shownBrowserTab();
    if (!t)
      cannot(T("cannot.browser.noTab.title"), T("cannot.browser.noTab.text"));
    return t;
  }
  /** 今のタブ。ページを開いていない新しいタブのページ（#238）なら「できない」と知らせて undefined（足す・コピー・検索などページが要る操作用）。 */
  function currentPage() {
    const t = currentTab();
    if (t && isNewTab(t)) {
      cannot(T("cannot.browser.newTab.title"), T("cannot.browser.newTab.text"));
      return undefined;
    }
    return t;
  }

  /** 内蔵ブラウザのコマンド（リーダーの o）。 */
  function runBrowser(c: Command) {
    const f = focus();
    switch (c.id) {
      case "browser.new":
      case "browser.incognito": {
        const g = currentGws();
        if (!g)
          cannot(T("cannot.browser.open.title"), T("cannot.browser.open.text"));
        else newBrowserTab(g, c.id === "browser.incognito");
        break;
      }
      case "browser.url": {
        const t = currentTab();
        if (t) {
          // ページから押したときに覚えた「戻す先」を捨てる（検索の欄と同じ。openFind）
          pageReturn = undefined;
          focusUrlBar?.();
        }
        break;
      }
      case "browser.back":
      case "browser.forward":
      case "browser.reload": {
        const t = currentTab();
        const action =
          c.id === "browser.back"
            ? "back"
            : c.id === "browser.forward"
              ? "forward"
              : "reload";
        if (t) void navTab(t.id, action).catch(() => {});
        break;
      }
      case "browser.close": {
        const t = currentTab();
        if (t) {
          removeTab(t.id);
          focusTerminal();
        }
        break;
      }
      case "browser.external": {
        const t = currentPage();
        if (t) openUrlFor(t.target, t.url);
        break;
      }
      case "browser.fold": {
        const g = currentGws();
        if (g) setGws((x) => toggleFold(x, g.id));
        break;
      }
      case "browser.rename": {
        const t = currentTab();
        if (t) setRenamingTab(t.id);
        break;
      }
      case "browser.bookmark": {
        const t = currentPage();
        if (t) bookmarkPage(t);
        break;
      }
      case "browser.bookmarks":
        setBookmarkDialog(true);
        // 開くたびに読み直す（読めなければ、前に読んだものを出す）
        readChromeBookmarks();
        readBookmarks().catch(() => {});
        break;
      case "browser.find": {
        const t = currentPage();
        if (t) openFind(t);
        break;
      }
      case "browser.copyUrl": {
        const t = currentPage();
        if (t) void copyToClipboard(t.url);
        break;
      }
      case "browser.devtools": {
        const t = currentPage();
        if (t)
          openTabDevtools(t.id).catch((e: unknown) =>
            setFocusError({
              title: T("err.devtools"),
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        break;
      }
    }
  }

  /** サイドバーのタブの行を押した。そのワークスペースでそのタブを出し、キーをそのタブに向ける。 */
  function selectTab(gid: string, key: string) {
    const ref = gws()
      .list.find((g) => g.id === gid)
      ?.tabs.find((r) => refKey(r) === key);
    if (ref) activateTab(gid, ref);
  }

  /** サイドバーのタブの行の ✕。ブラウザのタブはそのページを閉じ、ターミナルのタブはそのターミナルを終わらせる。 */
  function closeTabRow(gid: string, key: string) {
    const ref = untrack(gws)
      .list.find((g) => g.id === gid)
      ?.tabs.find((r) => refKey(r) === key);
    if (!ref) return;
    if (ref.kind === "term") {
      void closeTermTab(ref.target, ref.ws);
      return;
    }
    const shown = shownBrowserTab()?.id === ref.id;
    removeTab(ref.id);
    if (shown) focusTerminal();
  }

  // 閉じる前に確認している（プログラムが動いている）ターミナルのタブ
  const [confirmCloseTab, setConfirmCloseTab] = createSignal<{
    target: string;
    ws: WorkspaceId;
    name: string;
  } | null>(null);

  /**
   * ターミナルのタブ 1 つを閉じる（サイドバーのタブの行の ✕。#235 の t x もこれを使う）。ワークスペースの最後のターミナルのタブも閉じられる
   * （ワークスペースの最後のタブなら、ワークスペースも閉じる。#257）。
   * プログラムが動いていれば断られるので、確認の窓を出す（force は窓で「終わらせて閉じる」を押したとき）。
   * マシンにつながっていないタブは、閉じられないので記録から外すだけ。
   * フォーカスしているタブを閉じたら、同じワークスペースの隣のターミナルのタブに移る。
   * ターミナルのタブがもう無ければ、同じワークスペースのブラウザのタブ、それも無ければ（ワークスペースも閉じるので）サイドバーの隣のワークスペースに移る。
   */
  async function closeTermTab(target: string, ws: WorkspaceId, force = false) {
    const g = gwsOfTerm(untrack(gws), target, ws);
    if (!g) return;
    const terms = termsOf(g);
    const i = terms.findIndex((r) => r.target === target && r.ws === ws);
    if (i < 0) return;
    const nextTerm = terms[i + 1] ?? terms[i - 1];
    justCreated.delete(termKey(target, ws)); // 閉じたタブを、整理で守り続けない
    const tw = untrack(workspaces)[target]?.find((w) => w.id === ws);
    const name = tw ? band(tw, false).title : terms[i].title || unsetTitle();
    const s = sessions()[target];
    if (!s || states()[target]?.kind !== "connected") {
      setGws(dropTerm(untrack(gws), target, ws));
      return;
    }
    const f = untrack(focus);
    let moveTo: WorkspaceFocus | null = null;
    let onClosed: (() => void) | undefined;
    if (f?.target === target && f.id === ws && currentGws()?.id === g.id) {
      const browserRef = g.tabs.find((r) => r.kind === "browser");
      if (nextTerm) moveTo = { target: nextTerm.target, id: nextTerm.ws };
      else if (browserRef) {
        onClosed = () => {
          setTabs((t) => showTab(t, g.id, browserRef.id));
          showGws(g.id);
        };
      } else {
        // 最後のタブ：ワークスペースも閉じるので、サイドバーの隣のワークスペースへ
        const list = rows();
        const k = list.findIndex((r) => r.gws === g.id);
        const nr = list[k + 1] ?? list[k - 1];
        if (nr && !isBrowserOnly(nr))
          moveTo = { target: nr.target, id: nr.band.id };
        else if (nr) onClosed = () => showGws(nr.gws);
      }
    }
    await closeThenMove(
      moveTo,
      name,
      force,
      async () => {
        await s.closeWorkspace(ws, force);
        // マシンの一覧の知らせより先に記録から外す（移り先のブラウザのタブのワークスペースを、すぐターミナルのタブ無しとして扱えるように）
        setGws((x) => dropTerm(x, target, ws));
      },
      () => setConfirmCloseTab({ target, ws, name }),
      onClosed,
    );
  }

  // 名前を変えているターミナルのタブ（窓で変える。サイドバーのタブの行の鉛筆）
  const [renamingTerm, setRenamingTerm] = createSignal<{
    target: string;
    ws: WorkspaceId;
  } | null>(null);
  const [termRenameError, setTermRenameError] = createSignal<
    string | undefined
  >();

  /** サイドバーのタブの行の鉛筆。ブラウザのタブもターミナルのタブも、名前を変える窓を出す（空にすると、自動の名前に戻る）。 */
  function renameTabRow(gid: string, key: string) {
    const ref = untrack(gws)
      .list.find((g) => g.id === gid)
      ?.tabs.find((r) => refKey(r) === key);
    if (!ref) return;
    if (ref.kind === "browser") {
      setTabRenameError(undefined);
      setRenamingTab(ref.id);
    } else {
      setTermRenameError(undefined);
      setRenamingTerm({ target: ref.target, ws: ref.ws });
    }
  }

  /** ターミナルのタブの名前の窓で決めた（マシンのワークスペースの名前にする）。 */
  async function submitTermRename(name: string) {
    const r = renamingTerm();
    if (!r) return;
    const bad = nameErrorText(name);
    if (bad) {
      setTermRenameError(bad);
      return;
    }
    setRenamingTerm(null);
    try {
      await sessions()[r.target]?.renameWorkspace(r.ws, name.trim());
    } catch (e) {
      setFocusError({
        title: T("err.workspace.rename", { machine: labelOf(r.target) }),
        error: e instanceof Error ? e.message : String(e),
      });
    }
    focusTerminal();
  }

  // タブを足すマシンを選んでいる窓（「+」のメニューの「ターミナル（マシンを選ぶ）」）。足すワークスペースの id
  const [pickingFor, setPickingFor] = createSignal<string | null>(null);

  /**
   * 「+」のメニューで選んだタブを、ワークスペース gid に足す。選んでいないワークスペースなら、先にそこへ移ってから動く。
   * 中身は newTerminalTab・newBrowserTab で、キーを付けるとき（#235）もこの 2 つを使う。
   */
  async function addWorkspaceTab(gid: string, what: NewTabKind) {
    const g = untrack(gws).list.find((x) => x.id === gid);
    if (!g) return;
    const up = (m: string) => states()[m]?.kind === "connected";
    const rep = repTerm(g, untrack(focus), up);
    const inside = untrack(currentGws)?.id === gid;
    if (!inside) {
      if (rep) await switchWorkspace(rep.target, rep.ws);
      else showGws(gid);
    }
    if (what === "browser") newBrowserTab(g);
    // ターミナルのタブが無いワークスペースには、同じマシン・フォルダにする元のタブが無いので、マシンを選ぶ（t N と同じ）
    else if (what === "terminal.pick" || !rep) void newTerminalTab(gid);
    else {
      // 今のターミナルのタブと同じマシン・同じフォルダ（フォルダが未定なら、start_dir）
      const folder = untrack(workspaces)[rep.target]?.find(
        (w) => w.id === rep.ws,
      )?.folder;
      void newTerminalTab(gid, rep.target, folder ?? undefined);
    }
  }

  /**
   * ワークスペース gid にターミナルのタブを足す。target があればそのマシンに、無ければマシンを選ぶ窓を出して、選んだマシンに。
   * dir があれば、そのフォルダで始める。無ければ、マシンの start_dir で始まる（マシンを選ぶときは、別のマシンのフォルダは使えない）。
   */
  async function newTerminalTab(gid: string, target?: string, dir?: string) {
    if (target === undefined) {
      if (creatableRows(machineList()).length === 0)
        cannot(T("cannot.workspace.title"), T("cannot.workspace.text"));
      else setPickingFor(gid);
      return;
    }
    const s = sessions()[target];
    if (!s || states()[target]?.kind !== "connected") {
      cannot(
        T("err.tab.add", { machine: labelOf(target) }),
        T("cannot.tab.disconnected", { machine: labelOf(target) }),
      );
      return;
    }
    await createMachineWorkspace(
      target,
      "err.tab.add",
      (id) => {
        setGws((x) => addTerm(x, gid, target, id));
        setTabs((t) => showTab(t, gid, null));
      },
      dir,
    );
  }

  /** ワークスペース g にブラウザのタブを足す（新しいタブのページを出す。リーダーの o n と同じ）。 */
  function newBrowserTab(g: Gws, incognito = false) {
    const o = browserOrigin(g);
    openNewTab(o.target, o.ws, incognito, g.id);
  }

  /**
   * ワークスペース g に足すブラウザのタブの「開いたところ」（タブが覚えるマシンとワークスペース）。
   * ターミナルのタブがあれば、今出しているそのタブ。無ければ（ブラウザのタブだけのワークスペース。#257）、中のタブと同じマシンか今のマシンと、空のワークスペース
   */
  function browserOrigin(g: Gws): { target: string; ws: WorkspaceId } {
    const rep = repTerm(g, untrack(focus));
    if (rep) return { target: rep.target, ws: rep.ws };
    const own = untrack(tabs).tabs.find((t) =>
      g.tabs.some((r) => r.kind === "browser" && r.id === t.id),
    );
    return { target: own?.target ?? untrack(currentTarget) ?? LOCAL, ws: "" };
  }

  /** ブラウザのタブ id のタブがまだあるか（サイドバーに出るか）。 */
  const hasBrowserTab = (id: string) => tabs().tabs.some((t) => t.id === id);

  /** 今出しているタブの key（refKey）。ブラウザのタブを出していればそれ、そうでなければフォーカスしているターミナルのタブ。無ければ undefined。 */
  function currentTabKey(): string | undefined {
    const b = shownBrowserTab();
    if (b) return browserKey(b.id);
    // キーで移っている途中（返事が返るまで focus() が前のまま）は、向かっている先から数える（続けて押せるように）
    const f = heading ?? untrack(focus);
    return f ? termKey(f.target, f.id) : undefined;
  }

  /** リーダーの t j / t k。今のワークスペースのタブ（ターミナルのタブもブラウザのタブも、並びの順）を順に回る。端では反対の端へ回る。 */
  function stepTab(step: Step) {
    const g = currentGws();
    const key = currentTabKey();
    if (!g || !key) return;
    // サイドバーに出ていないタブと、つながっていないマシンのタブでは止まるので、飛ばす
    const list = steppableTabs(
      visibleTabs(g, hasBrowserTab),
      (m) => states()[m]?.kind === "connected",
      key,
    );
    const next = cycleKey({ ...g, tabs: list }, key, step);
    if (!next) focusTerminal();
    else if (next.kind === "term") {
      setTabs((t) => showTab(t, g.id, null));
      void goWorkspace(next.target, next.ws);
    } else activateTab(g.id, next);
  }

  /**
   * リーダーの t x。今出しているタブを閉じる。ブラウザのタブはそのページを閉じ、ターミナルのタブはそのターミナルを終わらせる
   * （プログラムが動いていれば確認を出す。closeTermTab）。ワークスペースの最後のタブを閉じると、ワークスペースも閉じる。
   */
  function closeCurrentTab() {
    const g = currentGws();
    const key = currentTabKey();
    if (!g || !key) return;
    closeTabRow(g.id, key);
  }

  // 直前に選んでいたワークスペース（リーダーの w Tab で戻る先）の GUI のワークスペースの id。
  // ターミナルのタブが無いワークスペースも覚えるので、focus ではなく今いるワークスペースの変化で覚える
  let lastWorkspace: string | null = null;
  createEffect(
    on(
      () => currentGws()?.id,
      (id, prev) => {
        if (prev && id !== prev) lastWorkspace = prev;
      },
    ),
  );

  /** 表示の大きさを変える（#594）。窓全体の zoom を変える。ターミナルは欄の変化で合わせ直す。 */
  function changeScale(a: ScaleAction) {
    scale = nextScale(scale, a);
    saveScale(store, scale);
    void applyScale(scale);
    showScale(scale);
  }

  /** 今のマシン（今のワークスペースのマシン。ワークスペースがまだ無ければ、先頭のマシン）。マシンのダイアログで最初に選ぶマシン。 */
  const currentTarget = (): string | undefined =>
    focus()?.target ?? groups()[0]?.target;

  /**
   * キーでワークスペースを移る（リーダーの w j / w k）。移ったら、そのワークスペースの欄にキーを向ける
   * （shj が動いているワークスペースなら、shj にキーが届く）。
   */
  async function goWorkspace(target: string, id: WorkspaceId) {
    // 返事を待つあいだに続けて押されたら、ここを起点に次を決める（focus() はまだ前のまま）
    const mine: WorkspaceFocus = { target, id };
    heading = mine;
    try {
      await switchWorkspace(target, id);
    } finally {
      if (heading === mine) heading = null;
    }
  }
  /** キーで移っている途中の、向かっている先（返事が返るまで focus() に反映されない）。無ければ null */
  let heading: WorkspaceFocus | null = null;

  /** リーダーの w j / w k。サイドバーの次・前のワークスペースへ（1 列の並びで。端では反対の端へ回る）。 */
  function stepWs(step: Step) {
    // つながっていないマシンのタブは移れない（そこで止まらないよう、飛ばす）
    // ターミナルのタブが無いワークスペースは、target が ""・id が GUI のワークスペースの id の組で数える
    const cur = untrack(currentGws);
    const here: WorkspaceFocus | null =
      cur && termsOf(cur).length === 0
        ? { target: "", id: cur.id }
        : stepFrom(heading, focus());
    const next = stepWorkspace(
      rows().filter((r) => r.health === "up" || r.band.focused),
      here,
      step,
    );
    if (next?.target === "") {
      setWalking(true);
      showGws(next.id);
    } else if (next) {
      setWalking(true);
      void goWorkspace(next.target, next.id);
    }
  }

  /**
   * リーダーの w J / w K。今のワークスペースを 1 つ下・上へ動かし、順を覚える（再起動しても残る）。端では動かさない。
   * 続けて押せる（押すたびに、今の並びから動かす）。
   */
  function moveWs(dir: "up" | "down") {
    const g = currentGws();
    if (!g) return;
    const next = moveGws(gws(), g.id, dir);
    if (next) setGws(next);
  }

  // ワークスペースを作るマシンを選んでいる窓（リーダーの w n）
  const [pickingMachine, setPickingMachine] = createSignal(false);
  // ワークスペースの種類（ターミナルかブラウザか）を選んでいる窓（リーダーの w n。内蔵ブラウザを有効にしているとき）
  const [pickingKind, setPickingKind] = createSignal(false);

  /**
   * リーダーの w n。内蔵ブラウザを有効にしていれば、先にターミナルかブラウザかを選ぶ（#257）。無効なら、ターミナルのワークスペースを作る。
   */
  function newWorkspace() {
    if (props.browser) setPickingKind(true);
    else newTerminalWorkspace();
  }

  /**
   * ターミナルのタブ 1 つのワークスペースを作る。どのマシンに作るかを選んでから作る。
   * つながっているマシンが 1 つしか無ければ選ぶ余地が無いので、窓を出さずにそこへ作る。1 つも無ければ、できないことを伝える。
   */
  function newTerminalWorkspace() {
    const up = creatableRows(machineList());
    if (up.length === 0) {
      cannot(T("cannot.workspace.title"), T("cannot.workspace.text"));
    } else if (up.length === 1) void createWorkspace(up[0].target);
    else setPickingMachine(true);
  }

  /**
   * ブラウザのタブ 1 つ（新しいタブのページ）のワークスペースを作って、そこへ移る。ターミナルのタブは無い。
   * タブの「開いたところ」のマシンは今のマシン（リモートの localhost の中継に使う）、ワークスペースは空。
   */
  function createBrowserWorkspace() {
    const gid = newGwsId();
    const id = newTabId();
    pageReturn = undefined;
    setTabs((s) =>
      addTab(
        s,
        {
          id,
          target: untrack(currentTarget) ?? LOCAL,
          workspace: "",
          url: NEW_TAB_URL,
          title: "",
        },
        gid,
      ),
    );
    setGws((g) => addBrowserWorkspace(g, id, gid));
    showGws(gid);
  }

  const machineList = () =>
    machineRows(groups(), statusOf, (t) => !!sessions()[t]);

  /** できないことを、右下の知らせで伝える（リーダーの葉は、できないときでも押せてしまうため）。 */
  function cannot(title: string, error: string) {
    setFocusError({ title, error });
  }

  /** キャラクターの読み直し・選び直しの結果。できなかったときは、その理由を伝える */
  function failed(f: Failure) {
    if (f) cannot(f.title, f.error);
  }

  /**
   * コマンドの表（commands.ts）のコマンドを動かす。リーダーの葉と近道の両方がここに来る。
   * キーの割り当ては表にあり、ここは動きだけを持つ。
   */
  function runCommand(c: Command) {
    const f = focus();
    if (c.id.startsWith("browser.")) {
      runBrowser(c);
      return;
    }
    // ターミナルのタブが無いワークスペースには、ペインが無い
    if (c.id.startsWith("pane.") && termless() !== null && shownBrowserTab()) {
      const g = currentGws();
      if (g && termsOf(g).length === 0) {
        cannot(T("cannot.pane.none.title"), T("cannot.pane.none.text"));
        return;
      }
    }
    // ブラウザのタブを出している間のペインの操作は、まずグリッドに戻す（見えないペインは動かさない）。
    // ペインを閉じる（p x）は、戻すだけで閉じない（どのペインが閉じるか見えないまま閉じないため）
    if (
      c.id.startsWith("pane.") &&
      c.id !== "pane.resize" &&
      f &&
      shownBrowserTab()
    ) {
      const g = currentGws();
      if (g) setTabs((s) => showTab(s, g.id, null));
      focusTerminal();
      if (c.id === "pane.close") return;
    }
    switch (c.id) {
      case "pane.focus":
        // 隠している間は、隣の欄が見えないので移らない
        if (!zoomed() && termGroup()?.move(c.arg as Direction)) focusTerminal();
        break;
      case "pane.last":
        if (!zoomed() && termGroup()?.focusPrevious()) focusTerminal();
        break;
      case "pane.swap":
        // 隠している間は、隣の欄が見えないので入れ替えない。フォーカスは今の欄についていく
        if (!zoomed()) termGroup()?.swap(c.arg as Direction);
        break;
      case "pane.split":
        newTerminal(c.arg as SplitDir);
        break;
      case "pane.close":
        // プライマリのターミナルは閉じず、何もしない
        termGroup()?.closeActive();
        break;
      case "pane.zoom":
        setZoom();
        break;
      case "pane.resize":
        // 入る・出るの両方（Cmd+R / Ctrl+Shift+R）
        setResizeMode(!resizeMode());
        break;
      case "workspace.nth": {
        // サイドバーの上から順に（1 列の並びで）。足りなければ何もしない
        const r = rows()[c.arg as number];
        if (r) goRow(r);
        break;
      }
      case "workspace.step":
        stepWs(c.arg as Step);
        break;
      case "workspace.move":
        moveWs(c.arg as "up" | "down");
        break;
      case "workspace.last": {
        const r = rows().find((x) => x.gws === lastWorkspace);
        if (r) goRow(r);
        break;
      }
      case "workspace.new":
        newWorkspace();
        break;
      case "workspace.close": {
        const g = currentGws();
        if (g) void closeWorkspace(g.id);
        break;
      }
      case "workspace.rename": {
        const g = currentGws();
        if (g) openWorkspaceRename(g.id);
        break;
      }
      case "tab.new":
      case "tab.newPick": {
        const g = currentGws();
        if (g)
          void addWorkspaceTab(
            g.id,
            c.id === "tab.new" ? "terminal" : "terminal.pick",
          );
        break;
      }
      case "tab.close":
        closeCurrentTab();
        break;
      case "tab.step":
        stepTab(c.arg as Step);
        break;
      case "tab.move": {
        const g = currentGws();
        const key = currentTabKey();
        if (g && key) {
          const next = moveTabStep(
            gws(),
            g.id,
            key,
            c.arg as "up" | "down",
            visibleTabs(g, hasBrowserTab),
          );
          if (next) setGws(next);
        }
        break;
      }
      case "tab.nth": {
        const g = currentGws();
        // サイドバーの上から n 番目（出ているタブだけを数える）
        const ref = g
          ? visibleTabs(g, hasBrowserTab)[c.arg as number]
          : undefined;
        if (g && ref) activateTab(g.id, ref);
        break;
      }
      case "tab.rename": {
        const g = currentGws();
        const key = currentTabKey();
        if (g && key) renameTabRow(g.id, key);
        break;
      }
      case "machine.dialog":
        setMachinesOpen(true);
        break;
      case "sidebar.toggle":
        toggleSidebar();
        break;
      case "clipboard.history":
        openClipboardHistory();
        break;
      case "scale": {
        // ブラウザを出している間は、ページの表示の大きさ（#205）。画面全体の大きさは、グリッドに戻してから変える
        const t = shownBrowserTab();
        if (t) changePageZoom(t, c.arg as ScaleAction);
        else changeScale(c.arg as ScaleAction);
        break;
      }
      case "notice.update":
        // 「新しい版があります」の「更新して再起動」。知らせが出ていないときは何もしない
        if (updateInfo()) void installUpdate();
        else cannot(T("cannot.update.title"), T("cannot.update.text"));
        break;
      case "notice.dismiss":
        if (updateInfo()) dismissUpdate();
        else notices().at(-1)?.dismiss?.();
        break;
      case "notice.openDownload":
      case "notice.revealDownload": {
        const d = lastDownload();
        if (d)
          useDownload(d, c.id === "notice.openDownload" ? "open" : "reveal");
        else cannot(T("cannot.download.title"), T("cannot.download.text"));
        break;
      }
      case "notice.focusNotified":
        focusLastNotified();
        break;
      case "mascot.select":
        setMascotPicking(true);
        break;
      case "mascot.reload":
        void reloadCurrent().then(failed);
        break;
      case "help.keys":
        // フォーカスがある場所（ツリー・変更一覧・動画・画像）のキーも出す
        openKeyList(placeOf(document.activeElement));
        break;
    }
  }

  /** 「足す」を押した。ssh でつなぎ（kisui が無ければ確認して送り）、つながったら保存する（下の effect）。 */
  function submitAdd(target: string, name: string) {
    const r = addMachine(machines(), target, name);
    if ("error" in r) {
      setAddError(r.error);
      return;
    }
    const m = r.machines[r.machines.length - 1];
    setAddError(undefined);
    setAddPending(m);
    connect(m.target);
  }

  // 足すためにつないだマシンの結果を待つ。つながったら保存して窓を閉じ、つなげなければ理由を窓に出して保存しない
  createEffect(() => {
    const p = addPending();
    if (!p) return;
    const st = states()[p.target];
    if (!st) return;
    untrack(() => {
      if (st.kind === "connected") {
        const r = addMachine(machines(), p.target, p.name);
        if ("machines" in r) updateMachines(r.machines);
        setAddPending(null);
        setAdding(false);
      } else if (st.kind === "failed" || st.kind === "superseded") {
        setAddError(
          st.kind === "failed"
            ? T("err.machine.connect", {
                machine: labelOf(p.target),
                message: st.message,
              })
            : T("err.machine.usedByOther", { machine: labelOf(p.target) }),
        );
        setAddPending(null);
        void disconnect(p.target);
      }
    });
  });

  /** 「キャンセル」と Esc。つないでいる最中ならつなぐのをやめる（保存しない）。 */
  function cancelAdd() {
    const p = addPending();
    setAddPending(null);
    setAdding(false);
    if (p) void disconnect(p.target);
  }

  function submitRename(target: string, name: string) {
    const r = renameMachine(machines(), target, name);
    if ("error" in r) {
      setRenameError(r.error);
      return;
    }
    updateMachines(r.machines);
    setRenaming(null);
  }

  /** 帯の名前をその場で変える入力欄を開く（帯の鉛筆・メニュー、リーダーの w r）。gid は GUI のワークスペースの id。 */
  function openWorkspaceRename(gid: string) {
    const g = gws().list.find((x) => x.id === gid);
    if (!g) return;
    // 閉じているサイドバーの中には入力欄が見えず、フォーカスも取れないので、先に開ける
    if (!untrack(sidebarOpen)) changeSidebarOpen(true);
    setWsRenameError(undefined);
    setRenamingWs({ gws: g.id, current: g.name, auto: autoName(g.num) });
  }

  /** 入力欄の Enter。空なら、つけた名前を外す（「ws1」の番号の名前に戻る）。断られたら入力欄の下に理由を出し、入力欄は開けておく。 */
  function submitWorkspaceRename(name: string) {
    const r = renamingWs();
    if (!r) return;
    const bad = nameErrorText(name);
    if (bad) {
      setWsRenameError(bad);
      return;
    }
    setGws((g) => renameGws(g, r.gws, name));
    setRenamingWs(null);
    focusTerminal();
  }

  /** ブラウザのタブの名前の窓で決めた。空なら、ページの題に戻る。 */
  function submitTabRename(name: string) {
    const id = renamingTab();
    if (id === null) return;
    const bad = nameErrorText(name);
    if (bad) {
      setTabRenameError(bad);
      return;
    }
    setGws((g) => renameBrowser(g, id, name));
    setRenamingTab(null);
    setTabRenameError(undefined);
    focusTerminal();
  }

  /** 入力欄の Esc（byKey）・フォーカスが外れたとき。Esc のときだけ、キーをターミナルに戻す。 */
  function cancelWorkspaceRename(byKey?: boolean) {
    if (!renamingWs()) return;
    setRenamingWs(null);
    if (byKey) focusTerminal();
  }

  /** 見出しのメニューの「外す」。記録から外し、GUI の接続を切る（そのマシンの kisui serve は止めない）。 */
  function removeFromSidebar(target: string) {
    updateMachines(removeMachine(machines(), target));
    void disconnect(target);
  }

  /** 見出しのそばのボタン。待ち時間中なら今すぐ、使い切った・引き継がれたあとならつなぎ直す。 */
  function retry(target: string) {
    const s = sessions()[target];
    if (!s) {
      connect(target); // 切った・つながなかったマシン
      return;
    }
    const st = s.state;
    if (st.kind === "failed" || st.kind === "superseded") connect(target);
    else if (
      (st.kind === "connecting" || st.kind === "reconnecting") &&
      st.retryAt !== undefined
    )
      s.retryNow();
  }

  // kisui を入れるかを聞くマシン（一度に 1 台。答えたら次のマシン）
  const installing = createMemo(() =>
    [...targets(), ...Object.keys(states())].find(
      (t) => states()[t]?.kind === "needs-install",
    ),
  );

  // 知らせのオブジェクトは、元のもの（SessionState・focusError のオブジェクト）が同じなら使い回す。
  // 作り直すと Notices が描き直し、ほかのマシンの状態が変わるだけで読み上げ直し、ボタンのフォーカスも消えるため
  const noticeOf = new WeakMap<SessionState, Notice | null>();
  const [shortcutDismissed, setShortcutDismissed] = createSignal(false);
  const shortcutNotice: Notice | undefined = props.shortcutProblems?.length
    ? {
        title: T("notice.shortcuts.title"),
        text: T("notice.shortcuts.text"),
        error: props.shortcutProblems.join("\n"),
        primary: {
          label: T("button.close"),
          run: () => setShortcutDismissed(true),
        },
        dismiss: () => setShortcutDismissed(true),
      }
    : undefined;
  const [passkeyDismissed, setPasskeyDismissed] = createSignal(false);
  const passkeyNotice: Notice | undefined = props.passkeyRejected?.length
    ? {
        title: T("notice.passkeySites.title"),
        text: T("notice.passkeySites.text"),
        error: props.passkeyRejected.join("\n"),
        primary: {
          label: T("button.close"),
          run: () => setPasskeyDismissed(true),
        },
        dismiss: () => setPasskeyDismissed(true),
      }
    : undefined;
  let focusNotice:
    { err: { title: string; error: string }; notice: Notice } | undefined;

  /** 右下に積む知らせ。つながらない・別の GUI に移った・ワークスペースに移れなかった・ファイルを開けなかった。 */
  const notices = createMemo<Notice[]>(() => {
    const out: Notice[] = [];
    if (shortcutNotice && !shortcutDismissed()) out.push(shortcutNotice);
    if (passkeyNotice && !passkeyDismissed()) out.push(passkeyNotice);
    const err = focusError();
    if (err) {
      if (focusNotice?.err !== err) {
        focusNotice = {
          err,
          notice: {
            title: err.title,
            error: err.error,
            primary: {
              label: T("button.close"),
              run: () => setFocusError(null),
            },
            dismiss: () => setFocusError(null),
          },
        };
      }
      out.push(focusNotice.notice);
    }
    for (const [t, st] of Object.entries(states())) {
      // 足している最中のマシンの失敗は、窓に出す
      if (!targets().includes(t)) continue;
      if (dismissed().has(st)) continue;
      if (!noticeOf.has(st)) noticeOf.set(st, makeNotice(t, st));
      const n = noticeOf.get(st);
      if (n) out.push(n);
    }
    // ダウンロード（#204）は最後に積む（リーダーの n d で、いちばん新しいものから閉じる）
    for (const d of downloads()) out.push(downloadNotice(d));
    return out;
  });

  /** マシン 1 台の状態の知らせ。知らせることが無ければ null。 */
  function makeNotice(t: string, st: SessionState): Notice | null {
    const label = labelOf(t);
    const close = {
      label: T("button.close"),
      run: () => setDismissed((d) => new Set(d).add(st)),
    };
    const cut = {
      label: T("button.disconnect"),
      run: () => void disconnect(t),
    };
    // ボタンと同じ動きのキー。マシンのダイアログ（リーダーの m）で、このマシンを選んで押す
    const leader = leaderKeyName(IS_MAC);
    const keys = T("notice.machine.keys", { leader });
    if (st.kind === "failed") {
      return {
        title: T("notice.machine.failed", { machine: label }),
        text: keys,
        error: st.message,
        secondary: [close, cut],
        dismiss: close.run,
        primary: { label: T("button.reconnect"), run: () => connect(t) },
      };
    }
    const failed = handoverFailure(label, st);
    if (failed) return { ...failed, primary: close, dismiss: close.run };
    if (st.kind === "superseded") {
      const who = st.by ? describeClient(st.by) : "";
      return {
        title: who
          ? T("notice.superseded.titleBy", { machine: label, who })
          : T("notice.superseded.title", { machine: label }),
        text: T("notice.superseded.text", { machine: label, keys }),
        secondary: [close, cut],
        dismiss: close.run,
        primary: { label: T("button.reconnect"), run: () => connect(t) },
      };
    }
    return null;
  }

  function reply(requestId: number, value: string | null) {
    setAsks((a) => a.filter((x) => x.requestId !== requestId));
    void api.askpassReply(requestId, value);
  }

  return (
    <main
      aria-label="shijimi-editor"
      class="app"
      ref={appEl}
      data-resizing={resizeMode() ? "" : undefined}
      data-lit-changes={lit("changes") ? "" : undefined}
      data-sidebar={sidebarOpen() ? "open" : "closed"}
      style={{
        "--sidebar-w": `${sizeOf(sizes(), "sidebar")}px`,
        "--changes-h": `${sizeOf(sizes(), "changes")}px`,
        ...(colors()[focus()?.target ?? ""]
          ? { "--machine-color": colors()[focus()!.target] }
          : {}),
      }}
    >
      <Sidebar
        rows={rows()}
        onNew={newWorkspace}
        // ワークスペースの帯を押すと、そのワークスペースが出していたものに移る（ブラウザのタブを出していたなら、そのページ）
        onFocus={goRow}
        onTab={selectTab}
        onTabClose={closeTabRow}
        onTabRename={renameTabRow}
        onAddTab={(gid, what) => void addWorkspaceTab(gid, what)}
        browser={props.browser}
        onTabsFold={(gid) => setGws((g) => toggleFold(g, gid))}
        onWorkspaceMove={(gid, before) => {
          const next = moveBefore(untrack(gws), gid, before);
          if (next) setGws(next);
        }}
        onTabMove={(gid, key, before) => {
          const next = moveTabBefore(untrack(gws), gid, key, before);
          if (next) setGws(next);
        }}
        treeOf={treeOf}
        onToggle={(t, id, p) => trees.get(t)?.toggle(id, p)}
        onClose={(gid) => void closeWorkspace(gid)}
        onRenameWorkspace={openWorkspaceRename}
        renaming={
          renamingWs() ? { ...renamingWs()!, error: wsRenameError() } : null
        }
        onRenameSubmit={submitWorkspaceRename}
        onRenameCancel={cancelWorkspaceRename}
        onOpen={openFile}
        changesOf={changesOf}
        onChange={openChange}
        onChangesKey={changesShjKey}
        onChangesExplorer={focusExplorer}
        onChangesLeave={() => focusTerminal()}
        onChangesResize={dragChanges}
        onChangesResizeReset={() =>
          changeSizes(withoutSize(sizes(), "changes"))
        }
        onTreeAction={treeAction}
        currentOf={currentOf}
        ref={(el) => {
          nav = el;
          el.addEventListener("scroll", rememberScroll, { passive: true });
        }}
      />
      <div
        class="resizer"
        data-axis="x"
        data-border="sidebar"
        data-lit={lit("sidebar") ? "" : undefined}
        aria-hidden="true"
        onPointerDown={(e) => dragBorder("sidebar", e)}
        onDblClick={() => changeSizes(withoutSize(sizes(), "sidebar"))}
      />
      <div class="main" ref={mainEl}>
        <TerminalGrid
          links={termList()}
          layout={termLayout()}
          titles={termGroup()?.titles}
          active={termActive()}
          extras={termExtras()}
          activeExtra={termActiveExtra()}
          readExtra={readExtra}
          onActivateExtra={(x) => termGroup()?.activateExtra(x)}
          onCloseExtra={(x) => termGroup()?.closeExtra(x)}
          onLeaveExtra={() => focusTerminal()}
          zoomed={zoomed()}
          onBorder={(k, r) => termGroup()?.setBorder(k, r)}
          litBorder={litSplit()}
          accent={colors()[termTarget() ?? ""]}
          onActivate={(i) => termGroup()?.setActive(i)}
          onUrl={openUrl}
          focusRef={(f) => (focusActiveTerminal = f)}
        />
        <Show when={props.browser}>
          <BrowserArea
            tabs={tabs().tabs}
            shown={shownBrowserTab()}
            zoom={() => scale}
            keys={() => interceptKeys(IS_MAC)}
            resolve={resolveFor}
            onError={(title, error) => setFocusError({ title, error })}
            focusRef={(f) => (focusBrowserPage = f)}
            leaderOpen={() => leaderPath() !== null}
          >
            <Show when={pageTabId()} keyed>
              {(id) => (
                <UrlBar
                  url={shownBrowserTab()?.url ?? ""}
                  onSubmit={(url) => submitUrlBar(id, url)}
                  onCancel={() => focusTerminal()}
                  onNav={(action) => {
                    void navTab(id, action).catch(() => {});
                    focusTerminal();
                  }}
                  focusRef={(f) => (focusUrlBar = f)}
                />
              )}
            </Show>
            <Show when={newTabPageId()} keyed>
              {(id) => (
                <NewTabPage
                  incognito={!!shownBrowserTab()?.incognito}
                  own={bookmarks()}
                  chrome={chromeBookmarks()}
                  failed={bookmarksFailed() && chromeCount() === 0}
                  onOpen={(url) => submitUrlBar(id, url)}
                  focusRef={(f) => (focusUrlBar = f)}
                />
              )}
            </Show>
            <Show when={findTab()} keyed>
              {(id) => (
                <FindBar
                  tab={id}
                  onClose={closeFind}
                  focusRef={(f) => (focusFind = f)}
                />
              )}
            </Show>
          </BrowserArea>
        </Show>
      </div>
      <Show when={installing()} keyed>
        {(t) => (
          <InstallCard
            target={labelOf(t)}
            state={
              states()[t] as Extract<SessionState, { kind: "needs-install" }>
            }
            onYes={() => void sessions()[t]?.install()}
            onNo={() => sessions()[t]?.declineInstall()}
          />
        )}
      </Show>
      <Show when={confirmClose()} keyed>
        {(c) => (
          <CloseWorkspaceCard
            name={c.name}
            onYes={() => {
              // <Show keyed> の c は値そのものなので、窓を閉じたあとに読んでよい（#162・#272）
              setConfirmClose(null);
              void closeWorkspace(c.gws, true);
            }}
            onNo={() => setConfirmClose(null)}
          />
        )}
      </Show>
      <Show when={mascotPicking()}>
        <MascotDialog
          onChoose={(name) => {
            setMascotPicking(false);
            void chooseMascot(name).then(failed);
          }}
          onCancel={() => setMascotPicking(false)}
        />
      </Show>
      <Show when={machinesOpen()}>
        <MachineDialog
          rows={machineList()}
          initial={currentTarget() ?? undefined}
          onAdd={() => {
            setAddError(undefined);
            setAdding(true);
          }}
          onAct={(action, row) => {
            switch (action) {
              case "rename":
                setRenameError(undefined);
                setRenaming(row.target);
                break;
              case "remove":
                removeFromSidebar(row.target);
                break;
              case "disconnect":
                void disconnect(row.target);
                break;
              case "reconnect":
                retry(row.target);
                break;
            }
          }}
          onCancel={() => setMachinesOpen(false)}
        />
      </Show>
      <Show when={pickingKind()}>
        <WorkspaceKindPicker
          onChoose={(kind) => {
            setPickingKind(false);
            if (kind === "browser") createBrowserWorkspace();
            else newTerminalWorkspace();
          }}
          onCancel={() => setPickingKind(false)}
        />
      </Show>
      <Show when={pickingMachine()}>
        <MachinePicker
          rows={creatableRows(machineList())}
          initial={currentTarget()}
          onChoose={(t) => {
            setPickingMachine(false);
            void createWorkspace(t);
          }}
          onCancel={() => setPickingMachine(false)}
        />
      </Show>
      <Show when={pickingFor()} keyed>
        {(gid) => (
          <MachinePicker
            rows={creatableRows(machineList())}
            initial={currentTarget()}
            onChoose={(t) => {
              setPickingFor(null);
              void newTerminalTab(gid, t);
            }}
            onCancel={() => setPickingFor(null)}
          />
        )}
      </Show>
      <Show when={adding()}>
        <AddMachine
          candidates={hosts().filter((h) => !targets().includes(h))}
          busy={addPending() !== null}
          state={addPending() ? states()[addPending()!.target] : undefined}
          error={addError()}
          onSubmit={submitAdd}
          onCancel={cancelAdd}
        />
      </Show>
      <Show when={renaming()} keyed>
        {(t) => (
          <RenameDialog
            current={labelOf(t)}
            fallback={t}
            error={renameError()}
            onSubmit={(name) => submitRename(t, name)}
            onCancel={() => setRenaming(null)}
          />
        )}
      </Show>
      <Show when={confirmCloseTab()} keyed>
        {(c) => (
          <CloseWorkspaceCard
            kind="tab"
            name={c.name}
            onYes={() => {
              setConfirmCloseTab(null);
              void closeTermTab(c.target, c.ws, true);
            }}
            onNo={() => setConfirmCloseTab(null)}
          />
        )}
      </Show>
      <Show when={renamingTerm()} keyed>
        {(r) => (
          <RenameDialog
            current={
              workspaces()[r.target]?.find((w) => w.id === r.ws)?.label ?? ""
            }
            fallback={(() => {
              const w = workspaces()[r.target]?.find((x) => x.id === r.ws);
              return w ? band({ ...w, label: "" }, false).title : "";
            })()}
            error={termRenameError()}
            onSubmit={(name) => void submitTermRename(name)}
            onCancel={() => {
              setRenamingTerm(null);
              focusTerminal();
            }}
          />
        )}
      </Show>
      <Show when={renamingTab()} keyed>
        {(id) => (
          <RenameDialog
            current={
              gws()
                .list.flatMap((g) => g.tabs)
                .flatMap((r) =>
                  r.kind === "browser" && r.id === id ? [r.name ?? ""] : [],
                )[0] ?? ""
            }
            fallback={tabs().tabs.find((t) => t.id === id)?.title ?? ""}
            error={tabRenameError()}
            onSubmit={submitTabRename}
            onCancel={() => {
              setRenamingTab(null);
              setTabRenameError(undefined);
              focusTerminal();
            }}
          />
        )}
      </Show>
      <Show when={treeDialog()} keyed>
        {(d) => (
          <Show
            when={d.kind === "delete"}
            fallback={
              <NameDialog
                title={
                  d.kind === "new-file"
                    ? T("dialog.tree.newFile")
                    : d.kind === "new-dir"
                      ? T("dialog.tree.newDir")
                      : T("dialog.tree.rename")
                }
                field={
                  d.kind === "rename"
                    ? T("dialog.tree.newPath")
                    : T("dialog.tree.path")
                }
                initial={d.kind === "rename" ? d.path : newEntryDefault(d.path)}
                submit={
                  d.kind === "rename"
                    ? T("dialog.tree.renameSubmit")
                    : T("dialog.tree.createSubmit")
                }
                selectName={d.kind === "rename"}
                onSubmit={submitTreeName}
                onCancel={() => setTreeDialog(null)}
              />
            }
          >
            <DeleteDialog
              path={d.path}
              dir={d.dir}
              onYes={submitTreeDelete}
              onCancel={() => setTreeDialog(null)}
            />
          </Show>
        )}
      </Show>
      <Show when={bookmarkDialog()}>
        <BookmarkDialog
          own={bookmarks()}
          chrome={chromeBookmarks()}
          failed={bookmarksFailed() && chromeCount() === 0}
          onOpen={openBookmark}
          onDelete={(b) => {
            // Chrome のブックマークは消せない（読むだけ。#239）
            if (b.source === "chrome")
              showToast(T("toast.bookmarks.chromeKept"));
            else changeBookmarks(removeBookmark(bookmarks() ?? [], b.url));
          }}
          onCancel={() => {
            setBookmarkDialog(false);
            focusTerminal();
          }}
        />
      </Show>
      <AskpassDialog ask={asks()[0]} onReply={reply} />
      <ClipboardDialog />
      <ClipboardHistoryDialog />
      <TransferDialog />
      <CopiedToast overPage={!!shownBrowserTab()} />
      <ScaleToast overPage={!!shownBrowserTab()} />
      <LeaderMenu />
      <KeyListDialog />
      <Notices notices={notices()}>
        <UpdateBar />
      </Notices>
    </main>
  );
}
