// GUI のワークスペース（#231）の持ち物と操作。
// ワークスペースは手元の GUI が持つ。中のターミナルのタブは、各マシンの kisui serve のワークスペース 1 つずつ。
// 名前・並び・中のタブは記録（KeyValueStore）に覚える（model.ts）。
// GUI のフォーカス（どのマシンの、どのワークスペースか）、ワークスペースを作る・閉じる・移る・並べ替える・名前を変える、を受け持つ。
// 中のタブを足す・閉じる・選ぶのは tabs/controller.ts。
// 画面にも Tauri にも触らない。キーをターミナルに向ける・サイドバーを開けるのは、受け取った関数に頼む。
import { T } from "../../i18n/index.ts";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  untrack,
} from "solid-js";

import { ErrorCode, RpcError } from "../../infrastructure/rpc/message.ts";
import type {
  Workspace,
  WorkspaceId,
} from "../../infrastructure/rpc/protocol.ts";
import { NEW_TAB_URL } from "../browser/newTab.ts";
import type { BrowserTabs } from "../browser/tabsStore.ts";
import { addTab, closeTab, newTabId } from "../browser/tabs.ts";
import type { KeyValueStore } from "../keyValueStore.ts";
import type { ReportProblem } from "../problem.ts";
import { MACHINE_COLORS } from "../sessions/colors.ts";
import type { Sessions } from "../sessions/controller.ts";
import { creatableRows, machineRows } from "../sessions/machineList.ts";
import { LOCAL } from "../sessions/shell.ts";
import { focusWorkspaceAndTerminal } from "./focusWorkspaceAndTerminal.ts";
import {
  addBrowserWorkspace,
  addWorkspace,
  autoName,
  displayName,
  dropTerm,
  EMPTY_GWS,
  gwsOfTerm,
  loadGws,
  move as moveGws,
  moveBefore,
  nameErrorText,
  newGwsId,
  reconcile,
  removeBrowser,
  rename as renameGws,
  saveGws,
  setActiveTerm,
  termKey,
  termsOf,
  type GwsState,
  type Lists,
} from "./model.ts";
import { loadOrder } from "./order.ts";
import {
  adoptFocus,
  band,
  buildSidebar,
  gwsRows,
  health,
  isBrowserOnly,
  keepFocus,
  shouldSendMoveTo,
  stepFrom,
  stepWorkspace,
  type Row,
  type Step,
  type WorkspaceFocus,
} from "./rows.ts";

export type Workspaces = ReturnType<typeof createWorkspaces>;

export function createWorkspaces(deps: {
  /** ワークスペースの名前・並びなどの記録の置き場 */
  store: KeyValueStore | undefined;
  /** 内蔵ブラウザのタブを使うか（設定の [gui.browser] enabled。#202） */
  browser: boolean;
  sessions: Sessions;
  browserTabs: BrowserTabs;
  /** ブラウザのタブのページ（子の webview）を壊す */
  closeTabView: (tab: string) => Promise<void>;
  /** できなかったことを知らせる */
  setFocusError: ReportProblem;
  /** 今使っているペイン（ブラウザのタブを出していればそのページ）にキーを向ける */
  focusTerminal: () => void;
  /** ページから押したときに覚えた「キーを戻す先」を捨てる（新しいタブのページの検索窓にキーを向けるのを、ページに戻させない） */
  forgetPageReturn: () => void;
  /** 閉じているサイドバーを開ける（帯の中の入力欄は、閉じたままでは見えず、フォーカスも取れない） */
  revealSidebar: () => void;
}) {
  const { store, setFocusError, focusTerminal, closeTabView } = deps;
  const {
    sessions,
    states,
    workspaces,
    targets,
    labelOf,
    fixedOf,
    colors,
    statusOf,
    shjFocuses,
  } = deps.sessions;
  const { tabs, tabsReady, setTabs } = deps.browserTabs;
  // GUI のフォーカスは 1 つ（どのマシンの、どのワークスペースか）
  const [focus, setFocus] = createSignal<WorkspaceFocus | null>(null);
  let focusSeq = 0;
  /** workspace.focus の返事を待っている（ワークスペースを移している途中） */
  let switching = false;
  /**
   * フォーカスしているワークスペースを閉じている途中の、移り先（閉じたものの隣）。
   * 一覧から消えた知らせ（workspace.changed）と shj のフォーカスが外れた知らせは閉じる返事より先に届くので、
   * そこでフォーカスを一度 null にせず、すぐこの移り先にする（サイドバーが一瞬フォーカス無しで描かれるのを防ぐ）
   */
  let closingNext: WorkspaceFocus | null = null;
  // workspace.step で続けて移っている間か（リーダーを閉じるまで）。この間はファイルツリーと CHANGES を出さず、
  // 1 つ移るごとにサイドバーが伸び縮みしないようにする（#140）
  const [walking, setWalking] = createSignal(false);

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
   * ワークスペースを作る（リーダーの w の窓の n）・ターミナルのタブを足す（「+」・t n）の共通の部分。dir があれば、そのフォルダでシェルを始める。
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
  /** 前の並び順の記録（窓の J・K）。初めてワークスペースを作るときの並びに使う */
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
    const browser = deps.browser && tabsReady() ? tabs().tabs : undefined;
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

  // 直前に選んでいたワークスペース（workspace.last で戻る先）の GUI のワークスペースの id。
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

  /** 今のマシン（今のワークスペースのマシン。ワークスペースがまだ無ければ、先頭のマシン）。マシンのダイアログで最初に選ぶマシン。 */
  const currentTarget = (): string | undefined =>
    focus()?.target ?? groups()[0]?.target;

  /**
   * キーでワークスペースを移る（設定の近道の workspace.step）。移ったら、そのワークスペースの欄にキーを向ける
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

  /** 設定の近道の workspace.step。サイドバーの次・前のワークスペースへ（1 列の並びで。端では反対の端へ回る）。 */
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
   * 設定の近道の workspace.move。今のワークスペースを 1 つ下・上へ動かし、順を覚える（再起動しても残る）。端では動かさない。
   * 続けて押せる（押すたびに、今の並びから動かす）。
   */
  function moveWs(dir: "up" | "down") {
    const g = currentGws();
    if (!g) return;
    const next = moveGws(gws(), g.id, dir);
    if (next) setGws(next);
  }

  // ワークスペースを作るマシンを選んでいる窓（リーダーの w の窓の n）
  const [pickingMachine, setPickingMachine] = createSignal(false);
  // ワークスペースの種類（ターミナルかブラウザか）を選んでいる窓（リーダーの w の窓の n。内蔵ブラウザを有効にしているとき）
  const [pickingKind, setPickingKind] = createSignal(false);

  /**
   * リーダーの w の窓の n。内蔵ブラウザを有効にしていれば、先にターミナルかブラウザかを選ぶ（#257）。無効なら、ターミナルのワークスペースを作る。
   */
  function newWorkspace() {
    if (deps.browser) setPickingKind(true);
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
    deps.forgetPageReturn();
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

  // 名前をその場で変えている帯の GUI のワークスペース（current はつけている名前、auto は空にしたときの名前）、変えられなかった理由
  const [renamingWs, setRenamingWs] = createSignal<{
    gws: string;
    current: string;
    auto: string;
  } | null>(null);
  const [wsRenameError, setWsRenameError] = createSignal<string | undefined>();

  /** 帯の名前をその場で変える入力欄を開く（帯の鉛筆・メニュー、リーダーの w の窓の r は行の中で変える。workspace.rename）。gid は GUI のワークスペースの id。 */
  function openWorkspaceRename(gid: string) {
    const g = gws().list.find((x) => x.id === gid);
    if (!g) return;
    // 閉じているサイドバーの中には入力欄が見えず、フォーカスも取れないので、先に開ける
    deps.revealSidebar();
    setWsRenameError(undefined);
    setRenamingWs({ gws: g.id, current: g.name, auto: autoName(g.num) });
  }

  /** ワークスペースの名前を決める（空なら、つけた名前を外して番号の名前に戻る）。名前の決まりに合わなければ、断る理由を返す（サイドバーの帯と切り替える窓の共通の部分）。 */
  function renameWorkspace(gid: string, name: string): string | undefined {
    const bad = nameErrorText(name);
    if (bad) return bad;
    setGws((g) => renameGws(g, gid, name));
    return undefined;
  }

  /** 入力欄の Enter。断られたら入力欄の下に理由を出し、入力欄は開けておく。 */
  function submitWorkspaceRename(name: string) {
    const r = renamingWs();
    if (!r) return;
    const bad = renameWorkspace(r.gws, name);
    if (bad) {
      setWsRenameError(bad);
      return;
    }
    setRenamingWs(null);
    focusTerminal();
  }

  /** 入力欄の Esc（byKey）・フォーカスが外れたとき。Esc のときだけ、キーをターミナルに戻す。 */
  function cancelWorkspaceRename(byKey?: boolean) {
    if (!renamingWs()) return;
    setRenamingWs(null);
    if (byKey) focusTerminal();
  }

  /** マシン target のワークスペースの一覧が変わった（一覧を書き換えたのと同じ batch の中で呼ばれる）。フォーカスを一覧に合わせ直す。 */
  function workspacesChanged() {
    setFocus((f) => keepFocus(f, workspaces(), shjFocuses(), closingNext));
  }

  /**
   * つないで最初に分かった一覧（マシンごとに 1 回だけ）。空なら、ワークスペースを 1 つ作る（何も無い画面から始めない）。
   */
  function firstList(target: string, ws: Workspace[]) {
    // 内蔵ブラウザを使っていて、ブラウザのタブだけのワークスペースがあれば、そこに居られるので作らない
    // （ブラウザのタブを読み終えたら、そこへ移る。上の effect）
    if (ws.length === 0) {
      if (
        deps.browser &&
        untrack(gws).list.some((g) => termsOf(g).length === 0)
      )
        setLanding(target);
      else void createWorkspace(target);
    }
  }

  /** マシン target の shj のフォーカスが変わった。GUI のフォーカスが無ければ、それを使う。 */
  function shjFocusChanged(target: string, id: WorkspaceId | null) {
    setFocus((f) =>
      keepFocus(
        adoptFocus(f, target, id),
        workspaces(),
        shjFocuses(),
        closingNext,
      ),
    );
  }

  /** マシンを切った（一覧から消したあと）。フォーカスを残った一覧に合わせ直す。 */
  function disconnected() {
    setFocus((f) => keepFocus(f, workspaces(), shjFocuses()));
  }

  return {
    /** GUI のフォーカス（どのマシンの、どのワークスペースか） */
    focus,
    /** workspace.focus の返事を待っている（ワークスペースを移している途中）か */
    isSwitching: () => switching,
    /** workspace.step で続けて移っている間か（リーダーを閉じるまで） */
    walking,
    /** リーダーを閉じた。続けて移る間は出さずにいたファイルツリーを、行き先のワークスペースの分だけ出す */
    endWalk: () => setWalking(false),
    folderOf,
    rootOf,
    focusWorkspace,
    switchWorkspace,
    createWorkspace,
    createMachineWorkspace,
    closeThenMove,
    /** 閉じる前に確認している（プログラムが動いている）ワークスペース */
    confirmClose,
    cancelClose: () => setConfirmClose(null),
    closeWorkspace,
    dropBrowserTab,
    groups,
    gws,
    setGws,
    /** ターミナルのタブを持たないワークスペースに居るなら、その id */
    termless,
    currentGws,
    showGws,
    goRow,
    /** 作ったばかりで、マシンの一覧の知らせがまだ届いていないターミナルのタブ（termKey） */
    justCreated,
    rows,
    currentTarget,
    goWorkspace,
    /** キーで移っている途中の、向かっている先（無ければ null） */
    heading: () => heading,
    stepWs,
    moveWs,
    /** workspace.nth：サイドバーの上から n 番目（0 始まり）のワークスペースへ移る。足りなければ何もしない */
    goNth(n: number) {
      const r = rows()[n];
      if (r) goRow(r);
    },
    /** workspace.last：直前に選んでいたワークスペースへ戻る */
    goLast() {
      const r = rows().find((x) => x.gws === lastWorkspace);
      if (r) goRow(r);
    },
    /** ワークスペース gid を 1 つ下・上へ動かす（切り替える窓の J・K）。端では動かさない */
    reorder(gid: string, dir: "up" | "down") {
      const next = moveGws(untrack(gws), gid, dir);
      if (next) setGws(next);
    },
    /** ワークスペース gid を before の前へ動かす（ドラッグ。before が null なら最後へ） */
    dropBefore(gid: string, before: string | null) {
      const next = moveBefore(untrack(gws), gid, before);
      if (next) setGws(next);
    },
    /** ワークスペースを作るマシンを選んでいる途中か（リーダーの w の窓の n） */
    pickingMachine,
    closeMachinePicker: () => setPickingMachine(false),
    /** ワークスペースの種類（ターミナルかブラウザか）を選んでいる途中か */
    pickingKind,
    closeKindPicker: () => setPickingKind(false),
    newWorkspace,
    newTerminalWorkspace,
    createBrowserWorkspace,
    machineList,
    /** つながっていて、ワークスペースを作れるマシン */
    creatable: () => creatableRows(machineList()),
    cannot,
    /** 名前をその場で変えている帯のワークスペース（無ければ null） */
    renamingWs,
    wsRenameError,
    openWorkspaceRename,
    renameWorkspace,
    /** 切り替える窓の行で名前を変え始めるときの、今の名前と、空にしたときの名前 */
    renameInit(gid: string) {
      const g = untrack(gws).list.find((x) => x.id === gid);
      return g ? { current: g.name, auto: autoName(g.num) } : undefined;
    },
    submitWorkspaceRename,
    cancelWorkspaceRename,
    workspacesChanged,
    firstList,
    shjFocusChanged,
    disconnected,
  };
}
