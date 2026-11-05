// 接続の画面（C3〜C7）。サイドバーに出るのは「このマシン」と、足したマシンだけ。起動時は、そのどれにも自動でつなぐ（C5）。
// 左の一覧の一番下の「+ マシンを足す」で窓を出し、ssh の行き先（~/.ssh/config のホストの候補か、打ったもの）を入れて
// shj につなぎ、つながったらマシンを保存して見出しを出す（connect/AddMachine.tsx。保存は ssh/machines.ts）。
// 足したマシンの見出しを右クリックすると、名前を変える・外す（外しても、そのマシンの shj serve は止めない）。ssh の質問（パスワードなど）と shj を入れるかの確認は窓に出す。
// 切れたら Session が自動でつなぎ直し、左の一覧の見出しに接続の状態を出す（丸・1 行・ボタン）。
// つながらない・別の GUI に引き継がれた（C7）ときは右下に知らせ、ボタンでつなぎ直せるようにする（connect/Notices.tsx）。
// 左にはつないだマシンごとの見出しとワークスペースの帯を出し、帯を押すとフォーカスを移す（D1）。
// フォーカスしているワークスペースの帯の下にはツリーを出す。開閉とスクロールの位置はワークスペースごとに覚え、
// フォーカスを外して戻しても残す（D2）。マシンごとに色を決めて覚え、見出しと帯の左端の線に使う（D4）。
// 右上にはフォーカスしているマシンの shj が送る画面のファイルの欄を描く（E1）。欄の大きさは、つないだ
// どのマシンにも送る（どのマシンにフォーカスを移しても、同じ大きさの欄に描くため）。
// 欄で受けたキー・IME・マウス・貼り付けは、フォーカスしているマシンの shj に送る。shj でコピーしたら
// OS のクリップボードに入れる（E2）。
// マシンの見出しの [+] でフォルダ未定のワークスペースを作り（フォルダはプライマリターミナルで cd すると決まる）、帯の [×] で閉じる
// （プログラムが動いていれば、先に確認の窓を出す）。ターミナルはワークスペースごとにあり、帯を押してフォーカスを移すと、
// 右下のターミナルもそのワークスペースのものに切り替わる（F2）。
// Ctrl+Shift+` でファイルの欄とターミナルのカードを入れ替える（IDE モードとターミナルモード。F3。mode.ts）。
// IDE モードでファイルを開いていない（ワークスペースが無いときも）あいだは、右の列を全部ターミナルにする（mode.ts）。
// ターミナルモードでは、フォーカスしているワークスペースのターミナル（先頭がプライマリ）を数に応じて自動で並べる。
// Ctrl+Shift+T で増やし、分割したターミナルの `exit` で閉じて並び直し、Ctrl+Shift+矢印で隣へ移る（F4。terminal/group.ts・
// terminal/grid.ts）。プライマリターミナルは `exit` しても閉じず、Enter で作り直す。
// 新しい版があれば右下に知らせ、押されたら入れ替えて起動し直す（C8。update/UpdateBar.tsx）。
// 窓と知らせは、どれもモック Connect.dc.html のカードの決まりで描く（connect/card.css）。
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type JSX,
  untrack,
} from "solid-js";

import { AskpassDialog } from "./AskpassDialog.tsx";
import { ClipboardDialog } from "./ClipboardDialog.tsx";
import { TransferDialog } from "./TransferDialog.tsx";
import { AddMachine } from "./connect/AddMachine.tsx";
import { ConfigError } from "./connect/ConfigError.tsx";
import { CloseWorkspaceCard } from "./connect/CloseWorkspaceCard.tsx";
import { InstallCard } from "./connect/InstallCard.tsx";
import { Notices, type Notice } from "./connect/Notices.tsx";
import { RenameMachine } from "./connect/RenameMachine.tsx";
import { describeClient, statusLine } from "./connect/status.ts";
import { UpdateBar } from "./update/UpdateBar.tsx";
import { BlobStore } from "./files/blob.ts";
import { OsClipboard } from "./files/clipboard.ts";
import {
  FilesView,
  type FilesSize,
  type SendInput,
} from "./files/FilesView.tsx";
import { ErrorCode, RpcError } from "./rpc/message.ts";
import type { Screen, Theme, Workspace, WorkspaceId } from "./rpc/protocol.ts";
import {
  adoptFocus,
  buildSidebar,
  keepFocus,
  type WorkspaceFocus,
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
import { currentFile, openErrorText, rows as treeRows } from "./tree/model.ts";
import { WorkspaceTrees } from "./tree/trees.ts";
import { directionKey, isNewTermKey } from "./terminal/grid.ts";
import { TermGroup, TermGroups } from "./terminal/group.ts";
import { TerminalGrid } from "./terminal/TerminalGrid.tsx";
import {
  hasOpenFile,
  isModeKey,
  otherMode,
  swapWithMotion,
  type Mode,
} from "./mode.ts";

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
  // 足したマシン（サイドバーには、これと「このマシン」だけを出す）
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
  const termActive = () => termGroup()?.active;
  // マシンごとのツリー（D2）。中身は WorkspaceTrees が持ち、変わったら treeVersion を進めて描き直す
  const trees = new Map<string, WorkspaceTrees>();
  const [treeVersion, setTreeVersion] = createSignal(0);
  // マシンごとの画像の実体（E6）。blob.get で取ったものを覚えておく
  const blobStores = new Map<string, BlobStore>();
  // マシンごとの画面とテーマ（E1）。Session が持つものを写す
  const [screens, setScreens] = createSignal<Record<string, Screen | null>>({});
  const [themes, setThemes] = createSignal<Record<string, Theme | null>>({});
  // ファイルの欄の大きさ。新しくつなぐマシンにも送る
  let filesSize: FilesSize | undefined;
  const clipboard = new OsClipboard(
    () => navigator.clipboard,
    (e) => console.warn("clipboard:", e),
  );
  let nav: HTMLElement | undefined;
  // IDE モード（上がファイルの欄）かターミナルモード（上がターミナル）か（F3）
  const [mode, setMode] = createSignal<Mode>("ide");
  let mainEl: HTMLDivElement | undefined;
  let focusActiveTerminal: (() => void) | undefined;
  // ファイルの欄に描く画面（フォーカスしているマシンのもの。フォーカスが無ければ null）
  // フォルダ未定のワークスペースには、ファイルの欄に出すものが無い（shj の画面は前のワークスペースのままかもしれない）
  const filesScreen = () => {
    const f = focus();
    if (!f || folderOf(f.target, f.id) === null) return null;
    return screens()[f.target] ?? null;
  };
  // ファイルを開いているか。開いていなければ、IDE モードでもファイルの欄を出さず右の列を全部ターミナルにする（mode.ts）
  const fileOpen = createMemo(() => hasOpenFile(filesScreen()?.files));
  // ツリーから開いたとき、ファイルの欄が出たらキーを向ける（出す前の欄にはフォーカスできない）
  let focusFilesWhenShown = false;
  createEffect(() => {
    if (!fileOpen() || !focusFilesWhenShown) return;
    focusFilesWhenShown = false;
    if (untrack(mode) === "ide") focusFiles();
  });
  // 逆に、最後のファイルを閉じた・ワークスペースが消えたなどで欄を隠したとき、キーが欄（か、隠れて外れた先の body）に
  // あれば、ターミナルに向ける（どこにもキーが届かなくなるため）
  createEffect<boolean>((was) => {
    const open = fileOpen();
    if (was && !open && untrack(mode) === "ide") {
      const a = document.activeElement;
      const inFiles = !!a?.closest(".main > .files");
      if (!a || a === document.body || inFiles) focusTerminal();
    }
    return open;
  }, false);
  const [asks, setAsks] = createSignal<AskpassRequest[]>([]);
  // マシンを足す窓を出しているか。足すためにつないでいる最中のマシン、足せなかった理由
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
  // GUI が受けるキーなので、欄やターミナルに届く前（capture）に取って、shj にもシェルにも送らない
  const onGuiKey = (e: KeyboardEvent) => {
    if (isModeKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) toggleMode();
      return;
    }
    if (isNewTermKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) newTerminal();
      return;
    }
    // 隣へ移るのは、ターミナルを並べていて、キーがターミナルに向いているときだけ（ファイルの欄の Ctrl+Shift+矢印は shj に送る）
    const dir = directionKey(e);
    const card = mainEl?.querySelector(":scope > .terminal");
    if (dir && mode() === "terminal" && card?.contains(e.target as Node)) {
      e.preventDefault();
      e.stopPropagation();
      if (termGroup()?.move(dir)) focusTerminal();
    }
  };
  window.addEventListener("keydown", onGuiKey, true);
  onCleanup(() => {
    window.removeEventListener("keydown", onGuiKey, true);
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
    // 質問の窓口を用意してから、「このマシン」と足したマシンにつなぐ
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
    blobStores.set(
      target,
      new BlobStore((params) => s.request("blob.get", params)),
    );
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
      setWorkspaces((m) => ({ ...m, [target]: ws }));
      setFocus((f) => keepFocus(f, workspaces(), shjFocuses()));
      // つないで最初に分かった一覧が空なら、ワークスペースを 1 つ作る（何も無い画面から始めない）。
      // 閉じて空になったときは作らない
      if (!started.has(target) && s.state.kind === "connected") {
        started.add(target);
        if (ws.length === 0) void createWorkspace(target);
      }
    });
    const offFocus = s.onFocus((id) =>
      setFocus((f) =>
        keepFocus(adoptFocus(f, target, id), workspaces(), shjFocuses()),
      ),
    );
    const showScreen = () => setScreens((m) => ({ ...m, [target]: s.screen }));
    const offScreen = s.onScreen(showScreen);
    const offUpdate = s.onUpdate(showScreen);
    const offTheme = s.onTheme((th) =>
      setThemes((m) => ({ ...m, [target]: th })),
    );
    const offClipboard = s.onClipboard((text) => void clipboard.write(text));
    offStates.set(target, () => {
      offTerm();
      off();
      offTree();
      offGit();
      offWs();
      offFocus();
      offScreen();
      offUpdate();
      offTheme();
      offClipboard();
    });
    if (filesSize) s.resize(filesSize);
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
    blobStores.get(target)?.clear();
    blobStores.delete(target);
    setSessions(({ [target]: _, ...rest }) => rest);
    setStates(({ [target]: _, ...rest }) => rest);
    setWorkspaces(({ [target]: _, ...rest }) => rest);
    setScreens(({ [target]: _, ...rest }) => rest);
    setThemes(({ [target]: _, ...rest }) => rest);
    setFocus((f) => keepFocus(f, workspaces(), shjFocuses()));
    await s.close();
  }

  /** ファイルの欄の大きさが変わった。つないでいるどのマシンにも送る。 */
  function resizeFiles(size: FilesSize) {
    filesSize = size;
    for (const s of Object.values(sessions())) s.resize(size);
  }

  /** ファイルの欄で受けた入力を、フォーカスしているマシンの shj に送る。 */
  const sendInput: SendInput = (method, params) => {
    const f = focus();
    if (f) sessions()[f.target]?.input(method, params);
  };

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
   * 帯の [×]。shj が開いているファイルを保存して閉じ、ターミナルを全部終わらせる。プログラムが動いていれば
   * 断られるので、確認の窓を出す（force は窓で「終わらせて閉じる」を押したとき）。保存できないファイルがあれば
   * 何も閉じずに、そのファイルを知らせる。フォーカスしているワークスペースを閉じたら、隣のワークスペースに移る。
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
    try {
      await s.closeWorkspace(id, force);
    } catch (e) {
      const d =
        e instanceof RpcError && e.code === ErrorCode.Busy
          ? (e.data as { reason?: string; paths?: string[] } | undefined)
          : undefined;
      if (d?.reason === "running" && !force) {
        setConfirmClose({ target, id, name });
        return;
      }
      setFocusError({
        title: `${name || "ワークスペース"} を閉じられませんでした`,
        error:
          d?.reason === "unsaved" && d.paths?.length
            ? `保存できないファイルがあります。\n${d.paths.join("\n")}`
            : e instanceof Error
              ? e.message
              : String(e),
      });
      return;
    }
    if (wasFocused && next) void focusWorkspace(target, next.id);
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
   * ツリーのファイルの行を押した。そのワークスペースで file.open を送り、ファイルの欄の
   * フォーカスしているペインで開く（pane を省くと shj はフォーカスしているペインで開く）。
   * 送れたら、IDE モードなら続けて打てるようにキーもファイルの欄に向ける。断られたら、帯を押して移れなかったときと同じ所に出す。
   * ワークスペースを移している途中は送らない（shj は file.open でフォーカスを動かさないので、開いても移った先では見えない）。
   */
  function openFile(target: string, id: WorkspaceId, path: string) {
    const s = sessions()[target];
    if (!s || switching || s.focus !== id) return;
    const seq = ++openSeq; // 続けて押したら、最後に押したものの失敗だけを出す
    setFocusError(null);
    const sent = s.input("file.open", { workspaceId: id, path }, (e) => {
      if (seq !== openSeq) return;
      focusFilesWhenShown = false;
      setFocusError({
        title: "ファイルを開けませんでした",
        error: openErrorText(path, e),
      });
    });
    if (sent === undefined || mode() !== "ide") return;
    // 初めて開くときは、まだファイルの欄を出していない。画面が来て欄が出てからキーを向ける
    if (fileOpen()) focusFiles();
    else focusFilesWhenShown = true;
  }

  /** ファイルの欄の入力用の textarea にキーを向ける。 */
  function focusFiles() {
    mainEl
      ?.querySelector<HTMLElement>(":scope > .files .files-ime")
      ?.focus({ preventScroll: true });
  }

  /** ファイルの欄でフォーカスしているペインが出しているファイル（ツリーで強調する行）。 */
  function currentOf(target: string, id: WorkspaceId) {
    const f = focus();
    if (f?.target !== target || f.id !== id) return undefined;
    return currentFile(screens()[target]?.files, rootOf(target, id));
  }

  /** IDE モードとターミナルモードを入れ替え、上に来た大きいカードにキーを向ける（F3）。 */
  function toggleMode() {
    const next = otherMode(mode());
    const files = mainEl?.querySelector<HTMLElement>(":scope > .files");
    const term = mainEl?.querySelector<HTMLElement>(":scope > .terminal");
    swapWithMotion([files, term], () => setMode(next));
    // ファイルの欄は入力用の textarea、ターミナルは今使っている欄（coneko-term）がキーを受ける。
    // ファイルを開いていなければ IDE モードでもファイルの欄を出さないので、ターミナルに向ける
    focusFilesWhenShown = false;
    if (next === "terminal" || !fileOpen()) focusTerminal();
    else focusFiles();
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

  /** 分割したターミナルを足して並べ、キーを向ける（Ctrl+Shift+T。F4）。フォーカスしているワークスペースに属する。 */
  function newTerminal() {
    // フォルダは shj が決める（ワークスペースのフォルダ。未定なら start_dir）
    void termGroup()
      ?.add()
      .then((added) => {
        if (added) focusTerminal();
      });
  }

  /** 「足す」を押した。ssh でつなぎ（shj が無ければ確認して送り）、つながったら保存する（下の effect）。 */
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
            : `${labelOf(p.target)} は別の GUI が使っています`,
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

  /** 見出しのメニューの「外す」。記録から外し、GUI の接続を切る（そのマシンの shj serve は止めない）。 */
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

  // shj を入れるかを聞くマシン（一度に 1 台。答えたら次のマシン）
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
        primary: { label: "つなぎ直す", run: () => connect(t) },
      };
    }
    if (st.kind === "superseded") {
      const who = st.by ? describeClient(st.by) : "";
      return {
        title: who
          ? `${label} は別の GUI に移りました（${who}）`
          : `${label} は別の GUI に移りました`,
        text:
          `${label} の作業は、あとからつないだ別の GUI に移りました。` +
          "取り合いにならないよう、自動ではつなぎ直しません。" +
          "「つなぎ直す」を押すとこちらに戻し、あちらの GUI が切れます。",
        secondary: [close, cut],
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
    <main aria-label="shijimi-editor" class="app">
      <Sidebar
        groups={groups()}
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
        currentOf={currentOf}
        ref={(el) => {
          nav = el;
          el.addEventListener("scroll", rememberScroll, { passive: true });
        }}
      />
      <div
        class="main"
        data-mode={mode()}
        data-no-file={fileOpen() ? undefined : ""}
        ref={mainEl}
      >
        <FilesView
          screen={filesScreen()}
          theme={focus() ? (themes()[focus()!.target] ?? null) : null}
          onResize={resizeFiles}
          onInput={sendInput}
          clipboard={clipboard}
          blobs={
            focus() && sessions()[focus()!.target]
              ? blobStores.get(focus()!.target)
              : undefined
          }
        />
        <TerminalGrid
          links={termList()}
          active={termActive()}
          showAll={mode() === "terminal"}
          accent={colors()[termTarget() ?? ""]}
          onActivate={(i) => termGroup()?.setActive(i)}
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
      <AskpassDialog ask={asks()[0]} onReply={reply} />
      <ClipboardDialog />
      <TransferDialog />
      <Notices notices={notices()}>
        <UpdateBar />
      </Notices>
    </main>
  );
}
