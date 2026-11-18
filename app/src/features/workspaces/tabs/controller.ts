// ワークスペースの中のタブ（ターミナルのタブとブラウザのタブ）の、追加・削除・並び順・選択・名前の変更。
// ターミナルのタブは、マシンの kisui serve のワークスペース 1 つ。ブラウザのタブのページの中身は features/browser/ が持つ。
// 画面にも Tauri にも触らない。
import { T } from "../../../i18n/index.ts";
import { createSignal, untrack } from "solid-js";

import type { WorkspaceId } from "../../../infrastructure/rpc/protocol.ts";
import type { Pages } from "../../browser/pages.ts";
import { closeTab, showTab } from "../../browser/tabs.ts";
import type { BrowserTabs } from "../../browser/tabsStore.ts";
import type { ReportProblem } from "../../problem.ts";
import type { Sessions } from "../../sessions/controller.ts";
import { LOCAL } from "../../sessions/shell.ts";
import type { Workspaces } from "../controller.ts";
import {
  addTerm,
  after,
  browserKey,
  cycleKey,
  dropTerm,
  gwsOfBrowser,
  gwsOfTerm,
  moveTabBefore,
  moveTabStep,
  nameErrorText,
  refKey,
  removeBrowser,
  renameBrowser,
  repTerm,
  shownBrowserId,
  steppableTabs,
  termKey,
  termsOf,
  visibleTabs,
  type Gws,
  type TabRef,
} from "../model.ts";
import { band, unsetTitle, type Step, type WorkspaceFocus } from "../rows.ts";

/** 「+」のメニューで選べるタブの種類。 */
export type NewTabKind = "terminal" | "terminal.pick" | "browser";

/** createTabs が返す持ち物。 */
export type Tabs = ReturnType<typeof createTabs>;

/** タブの操作を作る。タブを選ぶ・足す・閉じる・順に回る・並べ替える・名前を変えるを受け持ち、閉じたあとにどのタブ・ワークスペースへ移るかを決める。 */
export function createTabs(deps: {
  sessions: Sessions;
  workspaces: Workspaces;
  browserTabs: BrowserTabs;
  pages: Pick<Pages, "shownBrowserTab" | "openNewTab">;
  setFocusError: ReportProblem;
  /** 今使っているペイン（ブラウザのタブを出していればそのページ）にキーを向ける */
  focusTerminal: () => void;
}) {
  const { setFocusError, focusTerminal } = deps;
  const { sessions, states, workspaces, labelOf } = deps.sessions;
  const {
    focus,
    gws,
    setGws,
    currentGws,
    showGws,
    switchWorkspace,
    goWorkspace,
    createMachineWorkspace,
    closeThenMove,
    justCreated,
    creatable,
    cannot,
    currentTarget,
  } = deps.workspaces;
  const { tabs, setTabs } = deps.browserTabs;
  const { shownBrowserTab, openNewTab } = deps.pages;

  /**
   * ブラウザのタブを閉じる。出していたタブなら、同じワークスペースの次のタブ（無ければ前のタブ）を出す
   * （ふつうのブラウザで、今のタブを閉じたときと同じ。ターミナルのタブも並びの中にある）。
   * back（同じワークスペースのブラウザのタブ）を渡すと、次のタブの代わりにそれを出す（ページが自分を閉じたときに、開いた元のタブへ戻る。#204）。
   */
  function removeTab(id: string, back?: string) {
    const g = gwsOfBrowser(untrack(gws), id);
    const next =
      g && shownIdOf(g) === id ? after(g, browserKey(id), back) : undefined;
    // ワークスペースの最後のタブなら、ワークスペースは空になって残る（#307）。いま居るなら、そこに留まる（タブが無いことを伝える画面を出す）
    setTabs((s) => closeTab(s, id));
    setGws((x) => removeBrowser(x, id));
    if (g && next) activateTab(g.id, next);
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
   * （ワークスペースの最後のタブでも、ワークスペースは空になって残る。#307）。
   * プログラムが動いていれば断られるので、確認の窓を出す（force は窓で「終わらせて閉じる」を押したとき）。
   * マシンにつながっていないタブは、閉じられないので記録から外すだけ。
   * フォーカスしているタブを閉じたら、同じワークスペースの隣のターミナルのタブに移る。
   * ターミナルのタブがもう無ければ、同じワークスペースのブラウザのタブ、それも無ければ、空になったそのワークスペースに留まる。
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
      const stay = terms.length === 1 && untrack(currentGws)?.id === g.id;
      setGws(dropTerm(untrack(gws), target, ws));
      // 最後のターミナルのタブを外したら、そのワークスペース（残ったブラウザのタブか、空の画面）に留まる
      if (stay) showGws(g.id);
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
        // 最後のタブ：ワークスペースは空になって残るので、そこに留まる（#307。タブが無いことを伝える画面を出す）
        onClosed = () => showGws(g.id);
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

  // 名前を変えているブラウザのタブ（窓で変える。リーダーの o R）
  const [renamingTab, setRenamingTab] = createSignal<string | null>(null);
  const [tabRenameError, setTabRenameError] = createSignal<
    string | undefined
  >();

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
      if (creatable().length === 0)
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
    // ターミナルのタブを持たないワークスペースでは、focus に残っているのはほかのワークスペースのタブ（今のタブではない）
    if (deps.workspaces.inTermless()) return undefined;
    // キーで移っている途中（返事が返るまで focus() が前のまま）は、向かっている先から数える（続けて押せるように）
    const f = deps.workspaces.heading() ?? untrack(focus);
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
   * （プログラムが動いていれば確認を出す。closeTermTab）。ワークスペースの最後のタブを閉じても、ワークスペースは空になって残る（#307）。
   */
  function closeCurrentTab() {
    const g = currentGws();
    const key = currentTabKey();
    if (!g || !key) return;
    closeTabRow(g.id, key);
  }

  return {
    removeTab,
    activateTab,
    selectTab,
    closeTabRow,
    /** 閉じる前に確認している（プログラムが動いている）ターミナルのタブ */
    confirmCloseTab,
    cancelCloseTab: () => setConfirmCloseTab(null),
    closeTermTab,
    renameTabRow,
    /** 名前を変えているターミナルのタブ（無ければ null） */
    renamingTerm,
    termRenameError,
    submitTermRename,
    /** ターミナルのタブの名前の窓をやめる（キーをターミナルに戻す） */
    cancelTermRename() {
      setRenamingTerm(null);
      focusTerminal();
    },
    /** 名前を変えているブラウザのタブの id（無ければ null） */
    renamingTab,
    tabRenameError,
    /** ブラウザのタブ id の名前の窓を出す（リーダーの o R） */
    openTabRename: (id: string) => setRenamingTab(id),
    submitTabRename,
    /** ブラウザのタブの名前の窓をやめる（キーをページに戻す） */
    cancelTabRename() {
      setRenamingTab(null);
      setTabRenameError(undefined);
      focusTerminal();
    },
    /** タブを足すマシンを選んでいる途中の、足す先のワークスペースの id（無ければ null） */
    pickingFor,
    closeTabMachinePicker: () => setPickingFor(null),
    addWorkspaceTab,
    newTerminalTab,
    newBrowserTab,
    currentTabKey,
    stepTab,
    closeCurrentTab,
    /** ワークスペース gid のタブ key を before の前へ動かす（ドラッグ。before が null なら最後へ） */
    moveTabBefore(gid: string, key: string, before: string | null) {
      const next = moveTabBefore(untrack(gws), gid, key, before);
      if (next) setGws(next);
    },
    /** tab.move：今出しているタブを 1 つ下・上へ動かす。端では動かさない */
    moveCurrentTab(dir: "up" | "down") {
      const g = currentGws();
      const key = currentTabKey();
      if (g && key) {
        const next = moveTabStep(
          gws(),
          g.id,
          key,
          dir,
          visibleTabs(g, hasBrowserTab),
        );
        if (next) setGws(next);
      }
    },
    /** tab.nth：サイドバーの上から n 番目（0 始まり。出ているタブだけを数える）のタブを出す */
    goNthTab(n: number) {
      const g = currentGws();
      const ref = g ? visibleTabs(g, hasBrowserTab)[n] : undefined;
      if (g && ref) activateTab(g.id, ref);
    },
    /** tab.rename：今出しているタブの名前を変える */
    renameCurrentTab() {
      const g = currentGws();
      const key = currentTabKey();
      if (g && key) renameTabRow(g.id, key);
    },
  };
}
