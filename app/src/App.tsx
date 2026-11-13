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
import { Notices, type Notice } from "./connect/Notices.tsx";
import { RenameMachine } from "./connect/RenameMachine.tsx";
import {
  describeClient,
  handoverFailure,
  statusLine,
} from "./connect/status.ts";
import { UpdateBar } from "./update/UpdateBar.tsx";
import {
  checkNow,
  dismissUpdate,
  installUpdate,
  updateInfo,
} from "./update/store.ts";
import { OsClipboard } from "./clipboard.ts";
import { CopiedToast, copiedNotice } from "./CopiedToast.tsx";
import { ScaleToast, showScale } from "./ScaleToast.tsx";
import { copyAndNotify } from "./copiedNotice.ts";
import {
  applyMove,
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
  buildSidebar,
  keepFocus,
  shouldSendMoveTo,
  type WorkspaceFocus,
  stepFrom,
  stepMachine,
  stepWorkspace,
  type Step,
} from "./sidebar/model.ts";
import { machineColors } from "./sidebar/colors.ts";
import { Sidebar } from "./sidebar/Sidebar.tsx";
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
  route,
  type Command,
  type RouterState,
} from "./commands.ts";
import { closeTarget, IS_MAC } from "./guiKeys.ts";
import { KeyListDialog, openKeyList } from "./KeyListDialog.tsx";
import { placeOf } from "./placeKeys.ts";
import { LeaderMenu, setLeaderPath } from "./LeaderMenu.tsx";
import { loadScale, nextScale, saveScale, type ScaleAction } from "./scale.ts";
import { applyScale } from "./scaleOs.ts";
import type { Direction } from "./terminal/grid.ts";
import { focusLastNotified } from "./terminal/lastNotified.ts";
import type { UrlClick } from "coneko-term";
import { TermGroup, TermGroups } from "./terminal/group.ts";
import type { MediaFetch } from "./terminal/media.ts";
import { TerminalGrid } from "./terminal/TerminalGrid.tsx";
import { openUrlExternally } from "./terminal/openUrlOs.ts";
import { isOpenableUrl, isUrlOpenClick } from "./terminal/urlOpen.ts";

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
    { config: ConfigMachine[] } | { error: string } | null
  >(null);
  onMount(() => {
    api.configMachines().then(
      (config) => setLoaded({ config }),
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
          <Workbench api={api} store={props.store} config={v.config} />
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
  const lit = (b: Border) =>
    dragging() === b || (resizeMode() && litSplit() === undefined);
  const [asks, setAsks] = createSignal<AskpassRequest[]>([]);
  // リモートを足す窓を出しているか。足すためにつないでいる最中のマシン、足せなかった理由
  const [adding, setAdding] = createSignal(false);
  const [addPending, setAddPending] = createSignal<Machine | null>(null);
  const [addError, setAddError] = createSignal<string | undefined>();
  // 名前を変える窓を出しているマシン、変えられなかった理由
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [renameError, setRenameError] = createSignal<string | undefined>();
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
  // リーダー（Cmd+K / Ctrl+Shift+K）の状態。入っている間は、次に押せるキーの一覧を出す（LeaderMenu）
  let router: RouterState = IDLE;
  const setRouter = (next: RouterState) => {
    if (next.leader !== router.leader) setLeaderPath(next.leader);
    router = next;
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
      inPane: closeTarget(e.target, card, !!termGroup()) === "pane",
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
        if (ws.length === 0) void createWorkspace(target);
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
      else if (ev.kind === "open-url") openUrlFor(target, ev.url);
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

  /** 今の窓で効く境界の上限（app.css の clamp と同じ）。 */
  function maxOf(): number {
    return Math.min(640, window.innerWidth / 2);
  }

  /** リサイズモードで key（TUI と同じ名前。panes.ts）を押した。 */
  function resizeKey(key: string) {
    const a = resizeAction(key);
    switch (a.kind) {
      case "nudge": {
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
        // サイドバー、欄どうしの境界（木の順）の順に回す
        const order: (string | null)[] = [
          null,
          ...termBars().map((b) => b.key),
        ];
        const cur = litSplit() ?? null;
        const i = order.indexOf(cur);
        setResizeSel(order[(i + a.step + order.length) % order.length]);
        break;
      }
      case "reset": {
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

  /** サイドバーの境界のドラッグ。ポインタの位置が境界。 */
  function dragBorder(border: "sidebar", e: PointerEvent) {
    const box = appEl;
    if (e.button !== 0 || !box) return;
    const el = e.currentTarget as HTMLElement;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    setDragging(border);
    // つまみは境界の右の隙間にあるので、つかんだ位置と境界の差を覚えて、動かし始めに境界が跳ねないようにする
    // （境界の位置は、覚えた値ではなく画面に出ているつまみの左端から取る。窓が狭いと CSS が幅を縮めているため）
    const grab = e.clientX - el.getBoundingClientRect().left;
    const move = (ev: PointerEvent) => {
      const r = box.getBoundingClientRect();
      changeSizes(
        withSize(sizes(), border, ev.clientX - r.left - grab, maxOf()),
      );
    };
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
      setFocus({ target, id });
    } catch (e) {
      if (seq !== focusSeq) return;
      switching = false;
      // フォーカスしているワークスペースを閉じた返事を待つあいだに押して失敗した、など
      resyncShjFocus();
      setFocusError({
        title: `${labelOf(target)} のワークスペースに移れませんでした`,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * 見出しの [+]。フォルダ未定のワークスペースを作ってフォーカスし、プライマリターミナルにキーを向ける。
   * フォルダは、そのターミナルで cd すると決まる。
   */
  async function createWorkspace(target: string) {
    const s = sessions()[target];
    if (!s) return;
    setFocusError(null);
    try {
      const { id } = await s.createWorkspace();
      await focusWorkspace(target, id);
      if (focus()?.id === id) focusTerminal();
    } catch (e) {
      setFocusError({
        title: `${labelOf(target)} にワークスペースを作れませんでした`,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 閉じる前に確認している（プログラムが動いている）ワークスペース
  const [confirmClose, setConfirmClose] = createSignal<{
    target: string;
    id: WorkspaceId;
    name: string;
  } | null>(null);

  /**
   * 帯の [×]。ターミナルを全部終わらせる。プログラムが動いていれば断られるので、確認の窓を出す
   * （force は窓で「終わらせて閉じる」を押したとき）。フォーカスしているワークスペースを閉じたら、隣のワークスペースに移る。
   */
  async function closeWorkspace(
    target: string,
    id: WorkspaceId,
    force = false,
  ) {
    const s = sessions()[target];
    if (!s) return;
    const list = workspaces()[target] ?? [];
    const i = list.findIndex((w) => w.id === id);
    const next = list[i + 1] ?? list[i - 1];
    const wasFocused = focus()?.target === target && focus()?.id === id;
    const name =
      groups()
        .find((g) => g.target === target)
        ?.bands.find((b) => b.id === id)?.title ?? "";
    setFocusError(null);
    // 移り先は閉じる前に決めておき、一覧から消えた知らせを受けたところで（返事を待たずに）フォーカスを移す。
    // 移り先が無いとき（フォーカスしていないものを閉じる）は、先に閉じ始めたものの移り先を消さない
    const moveTo = wasFocused && next ? { target, id: next.id } : null;
    if (moveTo) closingNext = moveTo;
    try {
      await s.closeWorkspace(id, force);
    } catch (e) {
      if (moveTo && closingNext === moveTo) closingNext = null;
      const d =
        e instanceof RpcError && e.code === ErrorCode.Busy
          ? (e.data as { reason?: string } | undefined)
          : undefined;
      if (d?.reason === "running" && !force) {
        setConfirmClose({ target, id, name });
        return;
      }
      setFocusError({
        title: `${name || "ワークスペース"} を閉じられませんでした`,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (moveTo && closingNext === moveTo) closingNext = null;
    // GUI のフォーカスはもう移っている。shj にも移り先を伝える。
    // 待つあいだにユーザーが別の帯を選んだ・移り先も消えた、なら伝えない。
    // 押した帯の返事を待っている途中（switching）なら、その返事に任せる（失敗したら focusWorkspace が今のフォーカスを送り直す）
    if (moveTo && !switching && shouldSendMoveTo(focus(), moveTo, workspaces()))
      void focusWorkspace(target, moveTo.id);
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
    const f = focus();
    if (f && nav) trees.get(f.target)?.setScroll(f.id, nav.scrollTop);
  }

  function treeOf(target: string, id: WorkspaceId) {
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
      "ファイルを開けませんでした",
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
      "差分を出せませんでした",
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
            title: "CHANGES の操作ができませんでした",
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
        title: "プライマリターミナルに cd を送れませんでした",
        error: running
          ? "プライマリターミナルでプログラムが動いています。終わらせてからもう一度試してください。"
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
        throw new Error("つながっていません");
      return s.request("media.read", { workspaceId, id: pane.id, ...p });
    };
  }

  /** URL を手元の外部ブラウザで開く。リモートのマシンの localhost 系は、殻が `kisui relay` の中継越しに開く（#96・#127）。 */
  function openUrlFor(target: string, url: string) {
    if (!isOpenableUrl(url)) return;
    openUrlExternally(target, url).catch((e: unknown) =>
      setFocusError({
        title: "URL を開けませんでした",
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }

  /**
   * ターミナルの URL がクリックされた（#47）。cmd（macOS 以外は ctrl）を押していなければ何もしない。
   * cmd + クリックも cmd + shift + クリックも、手元の外部ブラウザで開く。開くのは http と https の URL だけ。
   */
  function openUrl(click: UrlClick) {
    if (!isOpenableUrl(click.url) || !isUrlOpenClick(click, IS_MAC)) return;
    const f = focus();
    if (f) openUrlFor(f.target, click.url);
  }

  /** 今使っているターミナルの欄にキーを向ける。 */
  function focusTerminal() {
    // 足した欄のターミナルが開くのを待つ（作ったばかりのワークスペースは、欄が描かれるまでもう少しかかる）
    const focus = () => focusActiveTerminal?.();
    queueMicrotask(() => {
      focus();
      if (!mainEl?.contains(document.activeElement))
        requestAnimationFrame(() => requestAnimationFrame(focus));
    });
  }

  /** 今の欄を右か下に分けてターミナルを足し、キーを向ける（Cmd+D・Ctrl+Shift+D など。F4）。フォーカスしているワークスペースに属する。 */
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

  // 直前に選んでいたワークスペース（リーダーの w Tab で戻る先）
  let lastWorkspace: WorkspaceFocus | null = null;
  createEffect(
    on(focus, (f, prev) => {
      if (prev && (f?.target !== prev.target || f?.id !== prev.id))
        lastWorkspace = prev;
    }),
  );

  /** 表示の大きさを変える（#594）。窓全体の zoom を変える。ターミナルは欄の変化で合わせ直す。 */
  function changeScale(a: ScaleAction) {
    scale = nextScale(scale, a);
    saveScale(store, scale);
    void applyScale(scale);
    showScale(scale);
  }

  // 各マシンで最後に選んでいたワークスペース（リーダーの w h / w l で、そのマシンへ移ったときの行き先）
  const lastOnMachine = new Map<string, WorkspaceId>();
  // ワークスペースが 1 つも無いマシンに、w h / w l で止まったときの、そのマシン（「選んでいるマシン」）。
  // ワークスペースを選ぶと外れる
  const [pickedMachine, setPickedMachine] = createSignal<string | null>(null);
  createEffect(
    on(focus, (f) => {
      if (f) lastOnMachine.set(f.target, f.id);
      setPickedMachine(null);
    }),
  );

  /** 今のマシン（w h / w l で止まったマシン。無ければ今のワークスペースのマシン。ワークスペースがまだ無ければ、先頭のマシン）。 */
  const currentTarget = (): string | undefined => {
    const p = pickedMachine();
    if (p && groups().some((g) => g.target === p)) return p;
    return focus()?.target ?? groups()[0]?.target;
  };

  /**
   * キーでワークスペースを移る（リーダーの w j / w k / w h / w l）。移ったら、そのワークスペースの欄にキーを向ける
   * （shj が動いているワークスペースなら、shj にキーが届く）。
   */
  async function goWorkspace(target: string, id: WorkspaceId) {
    // 返事を待つあいだに続けて押されたら、ここを起点に次を決める（focus() はまだ前のまま）
    const mine: WorkspaceFocus = { target, id };
    heading = mine;
    setPickedMachine(null);
    try {
      await focusWorkspace(target, id);
    } finally {
      if (heading === mine) heading = null;
    }
    const f = focus();
    if (f?.target === target && f.id === id) focusTerminal();
  }
  /** キーで移っている途中の、向かっている先（返事が返るまで focus() に反映されない）。無ければ null */
  let heading: WorkspaceFocus | null = null;

  /** リーダーの w j / w k。サイドバーの次・前のワークスペースへ（マシンをまたぐ。端で止まる）。 */
  function stepWs(step: Step) {
    const next = stepWorkspace(
      groups(),
      stepFrom(heading, focus()),
      step,
      pickedMachine(),
    );
    if (next) void goWorkspace(next.target, next.id);
  }

  /**
   * リーダーの w h / w l。前・次のマシンへ（端で止まる）。ワークスペースが有れば最後に選んでいたもの（無ければ先頭）へ、
   * 1 つも無いマシンならそのマシンを「選んでいるマシン」にして止まる。
   */
  function stepMachineTo(step: Step) {
    const next = stepMachine(
      groups(),
      heading?.target ?? currentTarget(),
      step,
      (t) => lastOnMachine.get(t),
    );
    if (!next) return;
    if (next.ws === null) {
      // 待っている移動は捨てる（返ってきても、止まったマシンの印を外したり、フォーカスを飛ばしたりしない）
      const dropped = heading;
      heading = null;
      focusSeq++;
      switching = false;
      // 捨てた移動の workspace.focus は、もう shj に届いている
      if (dropped) resyncShjFocus(dropped.target);
      setPickedMachine(next.target);
      return;
    }
    setPickedMachine(null);
    void goWorkspace(next.target, next.ws);
  }

  /** できないことを、右下の知らせで伝える（リーダーの m の下は、見出しの右クリックなどと違い、選べないものも押せてしまうため）。 */
  function cannot(title: string, error: string) {
    setFocusError({ title, error });
  }

  /** リーダーの m の下。今のマシンに、名前を変える・外す・切る・つなぎ直すを行う。できないマシンには、理由を知らせる。 */
  function runMachineCommand(
    id:
      | "machine.rename"
      | "machine.remove"
      | "machine.disconnect"
      | "machine.reconnect",
  ) {
    const t = currentTarget();
    const g = groups().find((x) => x.target === t);
    if (!t || !g) return;
    switch (id) {
      case "machine.rename":
      case "machine.remove":
        if (!g.removable || g.fixed) {
          cannot(
            `${g.label} は${id === "machine.rename" ? "名前を変えられません" : "外せません"}`,
            "「ローカル」と、設定ファイル（[[gui.machines]]）で決めたマシンは、名前を変えたり外したりできません。",
          );
        } else if (id === "machine.rename") {
          setRenameError(undefined);
          setRenaming(t);
        } else removeFromSidebar(t);
        break;
      case "machine.disconnect":
        if (!g.removable)
          cannot(`${g.label} は切れません`, "「ローカル」は切れません。");
        else void disconnect(t);
        break;
      case "machine.reconnect":
        retry(t);
        break;
    }
  }

  /**
   * コマンドの表（commands.ts）のコマンドを動かす。リーダーの葉と近道の両方がここに来る。
   * キーの割り当ては表にあり、ここは動きだけを持つ。
   */
  function runCommand(c: Command) {
    const f = focus();
    switch (c.id) {
      case "pane.focus":
        // 隠している間は、隣の欄が見えないので移らない
        if (!zoomed() && termGroup()?.move(c.arg as Direction)) focusTerminal();
        break;
      case "pane.last":
        if (!zoomed() && termGroup()?.focusPrevious()) focusTerminal();
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
        // サイドバーの上から順に（マシンをまたいで数える）。足りなければ何もしない
        const b = groups().flatMap((g) =>
          g.bands.map((x) => [g.target, x.id] as const),
        )[c.arg as number];
        if (b) void focusWorkspace(b[0], b[1]);
        break;
      }
      case "workspace.step":
        stepWs(c.arg as Step);
        break;
      case "machine.step":
        stepMachineTo(c.arg as Step);
        break;
      case "workspace.last": {
        const l = lastWorkspace;
        if (
          l &&
          groups().some(
            (g) => g.target === l.target && g.bands.some((b) => b.id === l.id),
          )
        )
          void focusWorkspace(l.target, l.id);
        break;
      }
      case "workspace.new": {
        const t = currentTarget();
        if (t) void createWorkspace(t);
        break;
      }
      case "workspace.close":
        if (f) void closeWorkspace(f.target, f.id);
        break;
      case "machine.add":
        setAddError(undefined);
        setAdding(true);
        break;
      case "machine.rename":
      case "machine.remove":
      case "machine.disconnect":
      case "machine.reconnect":
        runMachineCommand(c.id);
        break;
      case "sidebar.toggle":
        toggleSidebar();
        break;
      case "clipboard.history":
        openClipboardHistory();
        break;
      case "scale":
        changeScale(c.arg as ScaleAction);
        break;
      case "notice.act":
        // いちばん下のお知らせ（新しい版の知らせがあればそれ）の、主のボタン
        if (updateInfo()) void installUpdate();
        else notices().at(-1)?.primary?.run();
        break;
      case "notice.dismiss":
        if (updateInfo()) dismissUpdate();
        else notices().at(-1)?.dismiss?.();
        break;
      case "notice.focusNotified":
        focusLastNotified();
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
            ? `${labelOf(p.target)} につなげませんでした\n${st.message}`
            : `${labelOf(p.target)} は別の kisui-terminal が使っています`,
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
  let focusNotice:
    { err: { title: string; error: string }; notice: Notice } | undefined;

  /** 右下に積む知らせ。つながらない・別の GUI に移った・ワークスペースに移れなかった・ファイルを開けなかった。 */
  const notices = createMemo<Notice[]>(() => {
    const out: Notice[] = [];
    const err = focusError();
    if (err) {
      if (focusNotice?.err !== err) {
        focusNotice = {
          err,
          notice: {
            title: err.title,
            error: err.error,
            primary: { label: "閉じる", run: () => setFocusError(null) },
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
    return out;
  });

  /** マシン 1 台の状態の知らせ。知らせることが無ければ null。 */
  function makeNotice(t: string, st: SessionState): Notice | null {
    const label = labelOf(t);
    const close = {
      label: "閉じる",
      run: () => setDismissed((d) => new Set(d).add(st)),
    };
    const cut = { label: "切る", run: () => void disconnect(t) };
    if (st.kind === "failed") {
      return {
        title: `${label} につながりません`,
        error: st.message,
        secondary: [close, cut],
        dismiss: close.run,
        primary: { label: "つなぎ直す", run: () => connect(t) },
      };
    }
    const failed = handoverFailure(label, st);
    if (failed) return { ...failed, primary: close, dismiss: close.run };
    if (st.kind === "superseded") {
      const who = st.by ? describeClient(st.by) : "";
      return {
        title: who
          ? `${label} は別の kisui-terminal に移りました（${who}）`
          : `${label} は別の kisui-terminal に移りました`,
        text:
          `${label} の作業は、あとからつないだ別の kisui-terminal に移りました。` +
          "取り合いにならないよう、自動ではつなぎ直しません。" +
          "「つなぎ直す」を押すとこちらに戻し、あちらの kisui-terminal が切れます。",
        secondary: [close, cut],
        dismiss: close.run,
        primary: { label: "つなぎ直す", run: () => connect(t) },
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
      data-sidebar={sidebarOpen() ? "open" : "closed"}
      style={{
        "--sidebar-w": `${sizeOf(sizes(), "sidebar")}px`,
        ...(colors()[focus()?.target ?? ""]
          ? { "--machine-color": colors()[focus()!.target] }
          : {}),
      }}
    >
      <Sidebar
        groups={groups()}
        picked={pickedMachine()}
        onFocus={(t, id) => void focusWorkspace(t, id)}
        treeOf={treeOf}
        onToggle={(t, id, p) => trees.get(t)?.toggle(id, p)}
        statusOf={(t) =>
          sessions()[t]
            ? statusLine(states()[t], now())
            : { text: "つながっていません", title: "", retry: "again" }
        }
        onRetry={retry}
        onDisconnect={(t) => void disconnect(t)}
        onCreate={(t) => void createWorkspace(t)}
        onClose={(t, id) => void closeWorkspace(t, id)}
        onAddMachine={() => {
          setAddError(undefined);
          setAdding(true);
        }}
        onRename={(t) => {
          setRenameError(undefined);
          setRenaming(t);
        }}
        onRemove={removeFromSidebar}
        onOpen={openFile}
        changesOf={changesOf}
        onChange={openChange}
        onChangesKey={changesShjKey}
        onChangesExplorer={focusExplorer}
        onChangesLeave={() => focusTerminal()}
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
      </div>
      <Show when={installing()}>
        {(t) => (
          <InstallCard
            target={labelOf(t())}
            state={
              states()[t()] as Extract<SessionState, { kind: "needs-install" }>
            }
            onYes={() => void sessions()[t()]?.install()}
            onNo={() => sessions()[t()]?.declineInstall()}
          />
        )}
      </Show>
      <Show when={confirmClose()}>
        {(c) => (
          <CloseWorkspaceCard
            name={c().name}
            onYes={() => {
              setConfirmClose(null);
              void closeWorkspace(c().target, c().id, true);
            }}
            onNo={() => setConfirmClose(null)}
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
      <Show when={renaming()}>
        {(t) => (
          <RenameMachine
            current={labelOf(t())}
            target={t()}
            error={renameError()}
            onSubmit={(name) => submitRename(t(), name)}
            onCancel={() => setRenaming(null)}
          />
        )}
      </Show>
      <Show when={treeDialog()}>
        {(d) => (
          <Show
            when={d().kind === "delete"}
            fallback={
              <NameDialog
                title={
                  d().kind === "new-file"
                    ? "新しいファイル"
                    : d().kind === "new-dir"
                      ? "新しいフォルダ"
                      : "名前の変更"
                }
                field={
                  d().kind === "rename"
                    ? "新しいパス（ワークスペースのフォルダから）"
                    : "パス（ワークスペースのフォルダから）"
                }
                initial={
                  d().kind === "rename" ? d().path : newEntryDefault(d().path)
                }
                submit={d().kind === "rename" ? "変更する" : "作る"}
                selectName={d().kind === "rename"}
                onSubmit={submitTreeName}
                onCancel={() => setTreeDialog(null)}
              />
            }
          >
            <DeleteDialog
              path={d().path}
              dir={d().dir}
              onYes={submitTreeDelete}
              onCancel={() => setTreeDialog(null)}
            />
          </Show>
        )}
      </Show>
      <AskpassDialog ask={asks()[0]} onReply={reply} />
      <ClipboardDialog />
      <ClipboardHistoryDialog />
      <TransferDialog />
      <CopiedToast />
      <ScaleToast />
      <LeaderMenu />
      <KeyListDialog />
      <Notices notices={notices()}>
        <UpdateBar />
      </Notices>
    </main>
  );
}
