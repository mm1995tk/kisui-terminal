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
  addEmptyWorkspace,
  addWorkspace,
  autoName,
  displayName,
  dropTerm,
  EMPTY_GWS,
  gwsOfTerm,
  hiddenGws,
  loadGws,
  move as moveGws,
  moveBefore,
  nameErrorText,
  newGwsId,
  freeNum,
  reconcile,
  removeBrowser,
  removeGws,
  rename as renameGws,
  repTerm,
  saveGws,
  setActiveTerm,
  termKey,
  termsOf,
  type Gws,
  type GwsState,
  type Lists,
} from "./model.ts";
import { loadOrder } from "./order.ts";
import {
  band,
  buildSidebar,
  gwsOfShjFocus,
  gwsRows,
  health,
  isTermless,
  rowNear,
  stepRow,
  type Row,
  type Step,
  type WorkspaceFocus,
} from "./rows.ts";

/** createWorkspaces が返す持ち物。 */
export type Workspaces = ReturnType<typeof createWorkspaces>;

/** GUI のワークスペースの持ち物を作る。フォーカスとワークスペースの記録を持ち、マシンの一覧に記録を合わせ、作る・閉じる・移る・並べ替える・名前を変えるを受け持つ。 */
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

  // ---- GUI のワークスペース（#231）----
  // ワークスペースは手元の GUI が持つ。中のターミナルのタブは、各マシンの kisui serve のワークスペース 1 つずつ。
  // 名前・並び・中のタブは webview の localStorage に覚える（features/workspaces/model.ts）。
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
  /**
   * いま居る GUI のワークスペースの id（#307）。今いるワークスペースは、これだけで決まる（ターミナルのタブの有無によらない）。
   * 変わるのは、ユーザーが移ったとき（帯・キー・タブを選ぶ。ターミナルのタブなら shj が受け付けたあと）と、
   * 今のワークスペースが無くなったとき（閉じた・起動した直後で、まだ無い）だけ。タブを閉じても、shj のフォーカスが変わっても移らない
   */
  const [currentId, setCurrentId] = createSignal<string | null>(null);
  /** GUI がフォーカスしているワークスペース */
  const currentGws = (): Gws | undefined => {
    const id = currentId();
    return id === null ? undefined : gws().list.find((g) => g.id === id);
  };
  /**
   * GUI のフォーカス（どのマシンの、どのターミナルのタブか）。今いるワークスペースで最後に使ったターミナルのタブ（Gws.term。無ければ最初のもの）。
   * 今いるワークスペースがターミナルのタブを持たなければ（ブラウザのタブだけ・空）null。右のペインのターミナル・ツリー・CHANGES はこれのもの。
   * ほかのワークスペースのターミナルを指すことは無い
   */
  const focus = createMemo<WorkspaceFocus | null>(
    () => {
      const g = currentGws();
      const t = g ? repTerm(g) : undefined;
      return t ? { target: t.target, id: t.ws } : null;
    },
    null,
    { equals: (a, b) => a?.target === b?.target && a?.id === b?.id },
  );
  /** ワークスペース gid に入る。term を渡せば、そのターミナルのタブを最後に使ったものにする（focus がそれになる）。 */
  function enter(gid: string, term?: { target: string; ws: WorkspaceId }) {
    batch(() => {
      if (term) setGws((x) => setActiveTerm(x, term.target, term.ws));
      setCurrentId(gid);
    });
  }
  let focusSeq = 0;
  /** workspace.focus の返事を待っている（ワークスペースを移している途中） */
  let switching = false;
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
      // そのターミナルのタブを持つ GUI のワークスペースに入り、そのタブを出す（右のペインは focus から決まる）
      const g = gwsOfTerm(untrack(gws), target, id);
      if (g) enter(g.id, { target, ws: id });
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
   * 閉じる処理 close を動かす。プログラムが動いていて断られたら（force でないとき）onRunning を呼び、ほかの失敗は name を添えて伝える。
   * 閉じられたら onClosed を呼ぶ。今いるワークスペースは、タブを閉じても変わらない（閉じたタブの隣が出る。model.ts の passActiveTerm）。
   * ワークスペースを閉じる（✕）・ターミナルのタブを閉じる（✕）の共通の部分。
   */
  async function runClose(
    name: string,
    force: boolean,
    close: () => Promise<void>,
    onRunning: () => void,
    onClosed?: () => void,
  ) {
    setFocusError(null);
    try {
      await close();
    } catch (e) {
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
   * 中のタブを全部閉じたら、ワークスペースを並びから外す（タブを閉じるだけではワークスペースは残るので。空のワークスペースもこれで閉じる。#307）。
   * 今いるワークスペースを閉じたら、サイドバーの 1 列で隣のワークスペース（マシンが違ってもよい）に移る。
   */
  async function closeWorkspace(gid: string, force = false) {
    const g = untrack(gws).list.find((x) => x.id === gid);
    if (!g) return;
    const wasCurrent = untrack(currentId) === gid;
    // 中のタブを閉じている間は、タブが無くなっても「タブがありません」の画面を出さない（閉じ終えたら隣へ移るので）
    setClosing((c) => new Set(c).add(gid));
    await runClose(
      displayName(g),
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
        // 最後に、ワークスペースそのものを並びから外す（記録からも消えるので、再起動しても戻らない）。
        // 今いるワークスペースなら、同じ書き換えの中で隣へ移る（今のワークスペースが無い間を作らない）
        const next = rowNear(untrack(gws).list, untrack(rows), gid);
        batch(() => {
          setGws((x) => removeGws(x, gid));
          if (untrack(currentId) === gid) setCurrentId(next?.gws ?? null);
        });
      },
      () => setConfirmClose({ gws: gid, name: displayName(g) }),
      () => {
        if (wasCurrent) focusTerminal();
      },
    );
    // 閉じ終えた・断られた・確認の窓を出した（窓で続けるときは、また閉じ始める）
    setClosing((c) => {
      const n = new Set(c);
      n.delete(gid);
      return n;
    });
  }
  /** 中のタブを閉じている途中のワークスペースの id（空の画面を出さない。currentEmpty） */
  const [closing, setClosing] = createSignal<ReadonlySet<string>>(new Set());

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

  /** 前の並び順の記録（窓の J・K）。初めてワークスペースを作るときの並びに使う */
  const legacyOrder = loadOrder(store);
  /**
   * いま居るのが、タブが 1 つも無い空のワークスペース（#307）か。右のペインに、タブが無いことを伝える画面を出す。
   * 閉じている途中のワークスペースは除く（中のタブを閉じ終えて隣へ移るまでの間に、空の画面がちらつかないように）
   */
  const currentEmpty = () => {
    const g = currentGws();
    return !!g && g.tabs.length === 0 && !closing().has(g.id);
  };
  /** ターミナルのタブを持たないワークスペースで、行に出る（選べる）もの（model.ts の hiddenGws でないもの）。 */
  const landable = (g: Gws) =>
    termsOf(g).length === 0 && !hiddenGws(g, deps.browser);
  // 今いるワークスペースが、居る間に行に出ないものになったら（内蔵ブラウザを使わないときに、最後のターミナルのタブを閉じ、
  // ブラウザのタブの記録だけが残った）、並びで一番近い行のワークスペースへ移る。行に無いワークスペースに居続けない
  createEffect(() => {
    const g = currentGws();
    if (!g || !hiddenGws(g, deps.browser)) return;
    const r = rowNear(gws().list, rows(), g.id);
    untrack(() => setCurrentId(r?.gws ?? null));
  });
  /**
   * 起動したとき、ターミナルのタブが無くて、ターミナルのタブを持たないワークスペースへ入る待ち（値は、ワークスペースを作るはずだったマシン）。
   * ブラウザのタブを読み終えても、そのようなワークスペースの行が無ければ（記録が読めなかった・消えていた）、そのマシンにワークスペースを作る
   */
  const [landing, setLanding] = createSignal<string | null>(null);
  createEffect(() => {
    const target = landing();
    if (target === null) return;
    if (currentGws()) {
      setLanding(null);
      return;
    }
    // ブラウザのタブを読み終えるまでは、ブラウザのタブだけのワークスペースの行が無い。読めてから、並びで最初のものへ移る
    if (deps.browser && !tabsReady()) return;
    const r = rows().find(isTermless);
    setLanding(null);
    if (r) untrack(() => showGws(r.gws));
    else untrack(() => void createWorkspace(target));
  });
  /** ターミナルのタブを持たないワークスペースへ移る（ブラウザのタブがあればそのページに、空ならタブが無いことを伝える画面にキーを向ける）。shj には何も送らない。 */
  function showGws(gid: string) {
    // 行に出ないワークスペース（内蔵ブラウザを使わないときの、ブラウザのタブの記録だけのもの）へは移らない
    const g = untrack(gws).list.find((x) => x.id === gid);
    if (g && termsOf(g).length === 0 && !landable(g)) return;
    setCurrentId(gid);
    focusTerminal();
  }
  /** サイドバーの行 r のワークスペースへ移る。ターミナルのタブがあればそのタブ、無ければブラウザのタブのページ。 */
  function goRow(r: Row) {
    if (isTermless(r)) showGws(r.gws);
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
  /** つながって一覧が分かっているマシンの、ワークスペース（ターミナルのタブ）の一覧（reconcile に渡す形）。 */
  function knownLists(): Lists {
    const lists: Lists = {};
    for (const [t, ws] of Object.entries(workspaces()))
      if (states()[t]?.kind === "connected")
        lists[t] = ws.map((w) => ({ id: w.id, title: band(w, false).title }));
    return lists;
  }
  // マシンの一覧・ブラウザのタブに、ワークスペースの記録を合わせる（reconcile）
  createEffect(() => {
    const lists = knownLists();
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
  /**
   * 今のワークスペースが無いとき（起動した直後・閉じて移り先も無いとき）は、shj のフォーカスのターミナルのタブを持つワークスペースに入る。
   * 記録が読めた・一覧の知らせで整理が済んだ（gws が変わった）・shj のフォーカスが分かった（shjFocusChanged）たびに試す。
   * 今のワークスペースがあるうちは、何もしない
   */
  function adoptShjFocus() {
    const id = untrack(currentId);
    const list = untrack(gws);
    if (id !== null && list.list.some((g) => g.id === id)) return;
    const hit = gwsOfShjFocus(list, shjFocuses());
    if (hit) enter(hit.gws.id, hit.term);
    else if (id !== null) setCurrentId(null);
  }
  createEffect(on(gws, () => adoptShjFocus()));
  // GUI のフォーカスが変わったら（移った・閉じたタブの隣が出た）、そのマシンの shj のフォーカスも合わせる
  // （食い違うと、そのワークスペースのファイルや CHANGES の操作が無視される）。移る途中（switching）は、その返事に任せる
  createEffect(
    on(focus, (f) => {
      if (!f || switching) return;
      const s = untrack(sessions)[f.target];
      if (!s || untrack(states)[f.target]?.kind !== "connected") return;
      if (s.focus !== f.id) void s.focusWorkspace(f.id).catch(() => {});
    }),
  );

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
    const list = rows().filter((r) => r.health === "up" || r.band.focused);
    // 返事を待つあいだに続けて押されたら、向かっている先から数える（今のワークスペースは、返事が来るまで前のまま）
    const from =
      (heading
        ? gwsOfTerm(untrack(gws), heading.target, heading.id)?.id
        : undefined) ?? untrack(currentId);
    const id = stepRow(list, from, step);
    const next = list.find((r) => r.gws === id);
    if (!next) return;
    setWalking(true);
    if (isTermless(next)) showGws(next.gws);
    else void goWorkspace(next.target, next.band.id);
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

  /**
   * 切り替える窓の `n`：名前を付けて、タブの無い空のワークスペースを並びの一番下に作る（#330。種類もマシンも選ばない。タブは作ったあとに足す）。
   * 名前が空なら番号の名前になる。名前の決まりに合わなければ、断る理由を返す。今いるワークスペースは変えない（窓で選ぶだけ）。
   */
  function createEmptyWorkspace(
    name: string,
  ): { id: string } | { error: string } {
    const bad = nameErrorText(name);
    if (bad) return { error: bad };
    const id = newGwsId();
    setGws((g) => addEmptyWorkspace(g, name, id));
    return { id };
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

  /**
   * つないで最初に分かった一覧（マシンごとに 1 回だけ）。空なら、ワークスペースを 1 つ作る（何も無い画面から始めない）。
   */
  function firstList(target: string, ws: Workspace[]) {
    // ターミナルのタブを持たないワークスペース（ブラウザのタブだけ・空）があれば、そこに居られるので作らない
    // （ブラウザのタブを読み終えたら、そこへ移る。上の effect）
    if (ws.length === 0) {
      if (untrack(gws).list.some(landable)) setLanding(target);
      else void createWorkspace(target);
    }
  }

  /**
   * マシンの shj のフォーカスが分かった・変わった。今いるワークスペースが無いときだけ（起動した直後）、そのタブのワークスペースに入る。
   * 今いるワークスペースがあれば移らない（GUI のワークスペースを決めるのは GUI。#307）
   */
  function shjFocusChanged() {
    adoptShjFocus();
  }

  return {
    /** GUI のフォーカス（今いるワークスペースで出すターミナルのタブ。無ければ null） */
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
    runClose,
    /** 閉じる前に確認している（プログラムが動いている）ワークスペース */
    confirmClose,
    cancelClose: () => setConfirmClose(null),
    closeWorkspace,
    dropBrowserTab,
    groups,
    gws,
    setGws,
    /** いま居る GUI のワークスペースの id（無ければ null）。今いるワークスペースはこれだけで決まる（#307） */
    currentId,
    currentGws,
    /** ワークスペース gid に入る（term を渡せば、そのターミナルのタブを出す）。shj には、focus が変われば合わせる */
    enter,
    /** いま居るのが、タブが 1 つも無い空のワークスペースか */
    currentEmpty,
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
    createEmptyWorkspace,
    /** 切り替える窓で名前を入れてワークスペースを作るときの、空にしたときの番号の名前 */
    newWorkspaceAuto: () => autoName(freeNum(untrack(gws).list)),
    /** 切り替える窓の行で名前を変え始めるときの、今の名前と、空にしたときの名前 */
    renameInit(gid: string) {
      const g = untrack(gws).list.find((x) => x.id === gid);
      return g ? { current: g.name, auto: autoName(g.num) } : undefined;
    },
    submitWorkspaceRename,
    cancelWorkspaceRename,
    firstList,
    shjFocusChanged,
  };
}
