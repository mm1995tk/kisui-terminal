// ワークスペースの中のタブ（ターミナルのタブ・ブラウザのタブ・DB のタブ）の、追加・削除・並び順・選択・名前の変更。
// ターミナルのタブは、マシンの kisui serve のワークスペース 1 つ。ブラウザのタブのページの中身は features/browser/、DB のタブの中身は features/db/ が持つ。
// 画面にも Tauri にも触らない。
import { T } from "../../../i18n/index.ts";
import { batch, createSignal, untrack } from "solid-js";

import { ErrorCode, RpcError } from "../../../infrastructure/rpc/message.ts";
import type { WorkspaceId } from "../../../infrastructure/rpc/protocol.ts";
import type { Pages } from "../../browser/pages.ts";
import {
  addTab,
  closeTab,
  dropView,
  moveView,
  newTabId,
  showTab,
  showView,
} from "../../browser/tabs.ts";
import type { BrowserTabs } from "../../browser/tabsStore.ts";
import type { DbTabs } from "../../db/controller.ts";
import type { ReportProblem } from "../../problem.ts";
import type { Sessions } from "../../sessions/controller.ts";
import { LOCAL } from "../../sessions/shell.ts";
import type { Workspaces } from "../controller.ts";
import {
  addBrowser,
  addTerm,
  after,
  browserKey,
  browserOriginOf,
  cycleKey,
  dbKey,
  dropTerm,
  gwsOfBrowser,
  gwsOfDb,
  gwsOfTab,
  gwsOfTerm,
  moveTabStep,
  moveTabTo,
  nameErrorText,
  refKey,
  removeBrowser,
  removeDb,
  renamePage,
  repTerm,
  setActiveTerm,
  shownPage,
  shownTabKey,
  steppableTabs,
  termKey,
  termsOf,
  visibleTabs,
  dbRefLabel,
  type Gws,
  type TabRef,
} from "../model.ts";
import { band, unsetTitle, type Step } from "../rows.ts";

/** 「+」のメニューで選べるタブの種類。 */
export type NewTabKind = "terminal" | "terminal.pick" | "browser" | "db";

/** createTabs が返す持ち物。 */
export type Tabs = ReturnType<typeof createTabs>;

/** タブの操作を作る。タブを選ぶ・足す・閉じる・順に回る・並べ替える・名前を変えるを受け持ち、閉じたあとにどのタブ・ワークスペースへ移るかを決める。 */
export function createTabs(deps: {
  sessions: Sessions;
  workspaces: Workspaces;
  browserTabs: BrowserTabs;
  pages: Pick<Pages, "shownBrowserTab" | "openNewTab" | "openUrlTab">;
  /** DB のタブ（#347） */
  db: Pick<DbTabs, "shownDbTab" | "openPicker">;
  setFocusError: ReportProblem;
  /** 今使っているペイン（ブラウザのタブを出していればそのページ）にキーを向ける */
  focusTerminal: () => void;
  /** 閉じているサイドバーを開ける（タブの名前の入力欄を出す前） */
  revealSidebar: () => void;
}) {
  const { setFocusError, focusTerminal } = deps;
  const { sessions, states, workspaces, labelOf } = deps.sessions;
  const {
    focus,
    gws,
    setGws,
    currentGws,
    enter,
    rows,
    showGws,
    switchWorkspace,
    goWorkspace,
    createMachineWorkspace,
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
  /**
   * DB のタブ（#347）を閉じる。出していたタブなら、ブラウザのタブと同じに、同じワークスペースの次のタブ（無ければ前のタブ）を出す。
   * 書きかけの SQL を捨て、実行中の SQL を取り消すのは、記録から外れたのを見た features/db/controller.ts。
   */
  function removeDbTab(id: string) {
    const g = gwsOfDb(untrack(gws), id);
    const next = g && shownIdOf(g) === id ? after(g, dbKey(id)) : undefined;
    setTabs((s) => dropView(s, id));
    setGws((x) => removeDb(x, id));
    if (g && next) activateTab(g.id, next);
  }
  /** ワークスペース g が今出しているページのタブ（ブラウザのタブか DB のタブ）の id（ターミナルのタブを出していれば undefined。model.ts の shownPage）。 */
  function shownIdOf(g: Gws): string | undefined {
    const t = untrack(tabs);
    return shownPage(g, t.views[g.id], (id) => t.tabs.some((x) => x.id === id))
      ?.id;
  }

  /**
   * ワークスペース gid のタブ ref を出す。ブラウザのタブならそのページを、ターミナルのタブならそのターミナルのグリッドを。
   * ほかのワークスペースにいれば、そこへ移る（移るのは、そのワークスペースの今のターミナルのタブ。キーはそのタブに向く）。
   */
  function activateTab(gid: string, ref: TabRef) {
    const g = untrack(gws).list.find((x) => x.id === gid);
    if (!g) return;
    if (ref.kind === "browser") setTabs((s) => showTab(s, gid, ref.id));
    else if (ref.kind === "db") setTabs((s) => showView(s, gid, ref.id));
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
    if (ref.kind === "db") {
      const shown = deps.db.shownDbTab()?.id === ref.id;
      removeDbTab(ref.id);
      if (shown) focusTerminal();
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
   * ターミナルのタブ 1 つを閉じる（サイドバーのタブの行の ✕。コマンド tab.close もこれを使う）。ワークスペースの最後のターミナルのタブも閉じられる
   * （ワークスペースの最後のタブでも、ワークスペースは空になって残る。#307）。
   * プログラムが動いていれば断られるので、確認の Dialog を出す（force は Dialog で「終わらせて閉じる」を押したとき）。
   * マシンにつながっていないタブは、閉じられないので記録から外すだけ。
   * 出しているタブを閉じたら、同じワークスペースの隣のターミナルのタブに移る。
   * ターミナルのタブがもう無ければ、同じワークスペースのブラウザのタブ、それも無ければ、空になったそのワークスペースに留まる。
   */
  async function closeTermTab(target: string, ws: WorkspaceId, force = false) {
    const g = gwsOfTerm(untrack(gws), target, ws);
    if (!g) return;
    const terms = termsOf(g);
    const i = terms.findIndex((r) => r.target === target && r.ws === ws);
    if (i < 0) return;
    const tw = untrack(workspaces)[target]?.find((w) => w.id === ws);
    const name = tw ? band(tw, false).title : terms[i].title || unsetTitle();
    setFocusError(null);
    try {
      if ((await closeTermTabNow(target, ws, force)) === "running")
        setConfirmCloseTab({ target, ws, name });
    } catch (e) {
      setFocusError({
        title: T("err.workspace.close", { name }),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Terminal tab 1 つを、確認の Dialog を出さずに閉じる。閉じる手順の本体で、closeTermTab（Sidebar の ✕・Command tab.close）と
   * CLI の `kisui tab close`（#511）が使う。プログラムが動いていて force でなければ、閉じずに "running" を返す（Dialog を出すかは
   * 呼ぶ側が決める）。ほかの失敗は投げる。Machine につながっていない Tab は、閉じられないので記録から外すだけ。Tab がもう無ければ "gone"。
   * 出している Tab を閉じたら、閉じたあとに出るもの（隣の Terminal tab・Browser tab・空の画面）にキーを向ける。今いる Workspace は
   * 変わらず、出るものは記録から決まる（model.ts の passActiveTerm と shownBrowserId）。
   */
  async function closeTermTabNow(
    target: string,
    ws: WorkspaceId,
    force: boolean,
  ): Promise<"closed" | "running" | "gone"> {
    if (!gwsOfTerm(untrack(gws), target, ws)) return "gone";
    justCreated.delete(termKey(target, ws)); // 閉じたタブを、整理で守り続けない
    const s = sessions()[target];
    if (!s || states()[target]?.kind !== "connected") {
      setGws(dropTerm(untrack(gws), target, ws));
      return "closed";
    }
    const f = untrack(focus);
    const shown = f?.target === target && f.id === ws;
    try {
      await s.closeWorkspace(ws, force);
    } catch (e) {
      const d =
        e instanceof RpcError && e.code === ErrorCode.Busy
          ? (e.data as { reason?: string } | undefined)
          : undefined;
      if (d?.reason === "running" && !force) return "running";
      throw e;
    }
    // Machine の一覧の知らせが遅れても、すぐ隣の Tab を出すように、先に記録から外す
    setGws((x) => dropTerm(x, target, ws));
    if (shown) focusTerminal();
    return "closed";
  }

  // 名前をその場で変えているタブ（サイドバーのタブの行が入力欄になる。current は入力欄の初めの値、auto は空にしたときの名前）と、断られた理由
  const [renamingTab, setRenamingTab] = createSignal<{
    gws: string;
    key: string;
    current: string;
    auto: string;
  } | null>(null);
  const [tabRenameError, setTabRenameError] = createSignal<
    string | undefined
  >();

  /**
   * タブの名前をその場で変え始める（サイドバーのタブの行の鉛筆・tab.rename・browser.rename）。ブラウザのタブもターミナルのタブも同じ。
   * 空にして決めると、自動の名前（ターミナルはフォルダ名、ブラウザはページの題）に戻る。
   */
  function renameTabRow(gid: string, key: string) {
    const init = tabRenameInit(gid, key);
    if (!init) return;
    // 閉じているサイドバーの中には入力欄が見えず、フォーカスも取れないので、先に開ける
    deps.revealSidebar();
    setTabRenameError(undefined);
    setRenamingTab({ gws: gid, key, ...init });
  }

  /**
   * タブの名前の入力欄の初めの値（current）と、空にしたときの名前（auto）。タブが無ければ undefined。
   * サイドバーの入力欄（renameTabRow）も、Workspace switcher の入力欄も、これで開く。
   */
  function tabRenameInit(
    gid: string,
    key: string,
  ): { current: string; auto: string } | undefined {
    const ref = untrack(gws)
      .list.find((g) => g.id === gid)
      ?.tabs.find((r) => refKey(r) === key);
    if (!ref) return undefined;
    if (ref.kind === "browser")
      return {
        current: ref.name ?? "",
        auto: untrack(tabs).tabs.find((t) => t.id === ref.id)?.title ?? "",
      };
    if (ref.kind === "db")
      return { current: ref.name ?? "", auto: dbRefLabel(ref) };
    const w = untrack(workspaces)[ref.target]?.find((x) => x.id === ref.ws);
    return {
      current: w?.label ?? "",
      auto: w ? band({ ...w, label: "" }, false).title : "",
    };
  }

  /**
   * タブ key の名前を name にする（ブラウザのタブもターミナルのタブも）。付けられない名前なら、その理由を返して何も変えない。
   * 返ったあとの、ターミナルのタブのマシンへの知らせは待たない（失敗したら、フォーカスのあるペインにエラーを出す）。
   * Workspace switcher の入力欄が使う。サイドバーを開かずに変えられる。
   */
  function renameTab(
    gid: string,
    key: string,
    name: string,
  ): string | undefined {
    const r = tryRenameTab(gid, key, name);
    return typeof r === "string" ? r : undefined;
  }

  /** 名前を検査して、通れば変え始める。断る理由（string）か、変え終わるのを待つ Promise を返す。検査は、ここ 1 か所だけでする。 */
  function tryRenameTab(
    gid: string,
    key: string,
    name: string,
  ): string | Promise<void> {
    return nameErrorText(name) ?? applyTabRename(gid, key, name);
  }

  /** Tab key の名前を name にする。名前の検査は済んでいるものとする。Terminal tab の Machine が断ったら、フォーカスのある Pane にエラーを出す。 */
  async function applyTabRename(gid: string, key: string, name: string) {
    const ref = untrack(gws)
      .list.find((g) => g.id === gid)
      ?.tabs.find((x) => refKey(x) === key);
    try {
      await setTabName(gid, key, name);
    } catch (e) {
      setFocusError({
        title: T("err.workspace.rename", {
          machine: ref?.kind === "term" ? labelOf(ref.target) : "",
        }),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Tab key の名前を name にする（空なら自動の名前に戻す）。名前の検査は済んでいるものとする。Terminal tab の名前は、Machine の
   * kisui serve が持つ名前なので、Machine が断ったら投げる（CLI の `kisui tab rename` は、その理由を返す。#511）。
   */
  async function setTabName(gid: string, key: string, name: string) {
    const ref = untrack(gws)
      .list.find((g) => g.id === gid)
      ?.tabs.find((x) => refKey(x) === key);
    if (ref && ref.kind !== "term") setGws((g) => renamePage(g, key, name));
    else if (ref)
      await sessions()[ref.target]?.renameWorkspace(ref.ws, name.trim());
  }

  /** 入力欄の Enter。断られたら入力欄の下に理由を出し、入力欄は開けておく。 */
  async function submitTabRename(name: string) {
    const r = renamingTab();
    if (!r) return;
    const done = tryRenameTab(r.gws, r.key, name);
    if (typeof done === "string") {
      setTabRenameError(done);
      return;
    }
    setRenamingTab(null);
    setTabRenameError(undefined);
    await done;
    focusTerminal();
  }

  /** 入力欄の Esc（byKey）・フォーカスが外れたとき。Esc のときだけ、キーを今のペインに戻す。 */
  function cancelTabRename(byKey?: boolean) {
    if (!renamingTab()) return;
    setRenamingTab(null);
    setTabRenameError(undefined);
    if (byKey) focusTerminal();
  }

  // タブを足すマシンを選んでいる Dialog（「+」のメニューの「ターミナル（マシンを選ぶ）」）。足すワークスペースの id
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
    else if (what === "db") deps.db.openPicker(gid);
    // ターミナルのタブが無いワークスペースには、同じマシン・フォルダにする元のタブが無いので、マシンを選ぶ（tab.newPick と同じ）
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
   * ワークスペース gid にターミナルのタブを足す。target があればそのマシンに、無ければマシンを選ぶ Dialog を出して、選んだマシンに。
   * dir があれば、そのフォルダで始める。無ければ、マシンの start_dir で始まる（マシンを選ぶときは、別のマシンのフォルダは使えない）。
   * name があれば（Workspace switcher の入力欄）、その名前にする。作ったタブの key を返す（作れなければ undefined）。
   */
  async function newTerminalTab(
    gid: string,
    target?: string,
    dir?: string,
    name?: string,
  ): Promise<string | undefined> {
    if (target === undefined) {
      if (creatable().length === 0)
        cannot(T("cannot.workspace.title"), T("cannot.workspace.text"));
      else setPickingFor(gid);
      return undefined;
    }
    const s = sessions()[target];
    if (!s || states()[target]?.kind !== "connected") {
      cannot(
        T("err.tab.add", { machine: labelOf(target) }),
        T("cannot.tab.disconnected", { machine: labelOf(target) }),
      );
      return undefined;
    }
    const id = await createMachineWorkspace(
      target,
      "err.tab.add",
      (id) => {
        setGws((x) => addTerm(x, gid, target, id));
        setTabs((t) => showTab(t, gid, null));
      },
      dir,
      name,
    );
    return id === undefined ? undefined : termKey(target, id);
  }

  /**
   * Workspace switcher の「タブを作る」入力欄で決めた：ワークスペース gid の machine に、name の名前のターミナルのタブを作る（空ならマシンの自動の名前）。
   * 名前の決まりに合わなければ、何も作らず理由を返す。作れたら、作ったタブの key（作れなければ undefined）を、待てる形で返す。
   */
  function createNamedTerminalTab(
    gid: string,
    machine: string,
    name: string,
  ): { error: string } | { key: Promise<string | undefined> } {
    const bad = nameErrorText(name);
    if (bad) return { error: bad };
    return { key: newTerminalTab(gid, machine, undefined, name) };
  }

  /**
   * Workspace switcher の、作るタブの種類の「ブラウザ」「シークレット」：ワークスペース gid に、新しいタブのページのブラウザのタブ（incognito ならシークレットのタブ）を開く（今いるワークスペースは変えない）。
   * 開いたタブの key を返す（ワークスペースが無ければ undefined）。
   */
  function openNewBrowserTabIn(
    gid: string,
    incognito = false,
  ): string | undefined {
    const g = untrack(gws).list.find((x) => x.id === gid);
    if (!g) return undefined;
    return browserKey(newBrowserTab(g, incognito));
  }

  /** ワークスペース g にブラウザのタブを足す（新しいタブのページを出す。incognito ならシークレットのタブ。browser.new・browser.incognito と同じ）。 */
  function newBrowserTab(g: Gws, incognito = false): string {
    const o = browserOrigin(g);
    return openNewTab(o.target, o.ws, incognito, g.id);
  }

  /**
   * ワークスペース g に、ページ url のブラウザのタブ（incognito ならシークレットのタブ）を足して出す（`kisui browser new <url>`。#515）。
   * 開いたところは browserOrigin。作れなければ（リモートのマシンの localhost 系の中継を用意できない）理由で断る。作ったタブの id を返す。
   */
  function newBrowserTabAt(
    g: Gws,
    url: string,
    incognito = false,
  ): Promise<string> {
    const o = browserOrigin(g);
    return deps.pages.openUrlTab(o.target, o.ws, url, incognito, g.id);
  }

  /** ワークスペース g に足すブラウザのタブの「開いたところ」（model.ts の browserOriginOf）。 */
  function browserOrigin(g: Gws): { target: string; ws: WorkspaceId } {
    return browserOriginOf(
      g,
      untrack(tabs).tabs,
      untrack(currentTarget) ?? LOCAL,
    );
  }

  /**
   * 今いるワークスペースに、ページ url のブラウザのタブを足して出す（ブックマークの一覧で開く）。
   * 開いたところは browserOrigin（ターミナルのタブが無いワークスペースでも、ほかのワークスペースのタブを元にしない）。
   * 今いるワークスペースが無ければ、開かずに false。
   */
  function openBrowserTab(url: string, title: string): boolean {
    const g = untrack(currentGws);
    if (!g) return false;
    const o = browserOrigin(g);
    const id = newTabId();
    batch(() => {
      setTabs((s) =>
        addTab(s, { id, target: o.target, workspace: o.ws, url, title }, g.id),
      );
      setGws((x) => addBrowser(x, g.id, id));
    });
    return true;
  }

  /** ブラウザのタブ id のタブがまだあるか（サイドバーに出るか）。 */
  const hasBrowserTab = (id: string) => tabs().tabs.some((t) => t.id === id);

  /** 今出しているタブの key（refKey）。ブラウザのタブを出していればそれ、そうでなければフォーカスしているターミナルのタブ。無ければ undefined。 */
  function currentTabKey(): string | undefined {
    const b = shownBrowserTab();
    if (b) return browserKey(b.id);
    const d = deps.db.shownDbTab();
    if (d) return dbKey(d.id);
    // キーで移っている途中（返事が返るまで focus() が前のまま）は、向かっている先から数える（続けて押せるように）
    const f = deps.workspaces.heading() ?? untrack(focus);
    return f ? termKey(f.target, f.id) : undefined;
  }

  /** コマンド tab.step。今のワークスペースのタブ（ターミナルのタブもブラウザのタブも、並びの順）を順に回る。端では反対の端へ回る。 */
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
   * コマンド tab.close。今出しているタブを閉じる。ブラウザのタブはそのページを閉じ、ターミナルのタブはそのターミナルを終わらせる
   * （プログラムが動いていれば確認を出す。closeTermTab）。ワークスペースの最後のタブを閉じても、ワークスペースは空になって残る（#307）。
   */
  function closeCurrentTab() {
    const g = currentGws();
    const key = currentTabKey();
    if (!g || !key) return;
    closeTabRow(g.id, key);
  }

  /**
   * タブ key（refKey）を、ワークスペース to の before のタブの前へ移す（before が null なら一番後ろ）。別のワークスペースへも移せる（#308）。
   * 書き換えるのは、記録の所属と並び（model.ts の moveTabTo）と、ワークスペースごとに出しているタブだけで、1 回の書き換えにまとめる
   * （途中の状態を画面に出さない）。タブを閉じたり作り直したりしない：ターミナルのタブはマシンの同じワークスペースのまま、
   * ブラウザのタブは同じ id のページのまま（開いたときのマシンとワークスペースも書き換えないので、リモートの localhost の中継元も変わらない）。
   * mode が "go"（キーで移動先を選んだ）なら、移動先のワークスペースへ移って、移したタブを出す。
   * "stay"（ドラッグ）なら、今いるワークスペースは変えない。移動元で出していたタブを移したときだけ、移動先でもそのタブを出す。
   * それ以外では、移動先が出しているタブは変えない。
   * 移動元は、出していたターミナルのタブを移したら、閉じたときと同じに隣のターミナルのタブを出す（model.ts の passActiveTerm。無ければブラウザのタブ）。
   * 出していたブラウザのタブを移したら、ターミナルのタブを出す（無ければ、残りの最初のブラウザのタブ）。閉じたとき（並びの次のタブを出す。
   * model.ts の after）とは違う：移したあとは移動先を見ることが多いので、移動元は、覚えた表示を外すだけにしている。
   * 動かせなかった（タブか移動先が無い・もうそこにある）ら false。
   */
  function moveTab(
    key: string,
    to: string,
    before: string | null,
    mode: "go" | "stay",
  ): boolean {
    const s = untrack(gws);
    const from = gwsOfTab(s, key);
    const dest = s.list.find((g) => g.id === to);
    const next = moveTabTo(s, key, to, before);
    const ref = from?.tabs.find((r) => refKey(r) === key);
    if (!from || !dest || !ref || !next) return false;
    if (from.id === to) {
      setGws(next);
      return true;
    }
    const t = untrack(tabs);
    const has = (id: string) => t.tabs.some((x) => x.id === id);
    const show =
      mode === "go" || shownTabKey(from, t.views[from.id], has) === key;
    // 移動先が出していたページのタブ（ターミナルのタブが無くて、覚えずに出していたものも）。移したタブを出さないなら、これを出し続ける
    const destPage = shownPage(dest, t.views[to], has)?.id;
    batch(() => {
      setGws(
        show && ref.kind === "term"
          ? setActiveTerm(next, ref.target, ref.ws)
          : next,
      );
      setTabs((v) =>
        moveView(v, {
          tab: ref.kind === "term" ? null : ref.id,
          from: from.id,
          to,
          show,
          destShown: destPage,
        }),
      );
      if (mode === "go")
        enter(
          to,
          ref.kind === "term" ? { target: ref.target, ws: ref.ws } : undefined,
        );
    });
    if (mode === "go") focusTerminal();
    return true;
  }

  // 別のワークスペースへ移すタブ（移動先を選ぶ Dialog を出している。コマンド tab.moveTo）。key は refKey、from は今のワークスペースの id
  const [movingTab, setMovingTab] = createSignal<{
    key: string;
    from: string;
  } | null>(null);

  /** tab.moveTo：今出しているタブを移す先のワークスペースを選ぶ Dialog を出す。タブが無い・ほかのワークスペースが無いときは、できないことを伝える。 */
  function openTabMove() {
    const g = currentGws();
    const key = currentTabKey();
    if (!g || !key || gwsOfTab(untrack(gws), key)?.id !== g.id) {
      cannot(T("cannot.tabMove.title"), T("cannot.tabMove.noTab"));
      return;
    }
    if (!untrack(rows).some((r) => r.gws !== g.id)) {
      cannot(T("cannot.tabMove.title"), T("cannot.tabMove.noWorkspace"));
      return;
    }
    setMovingTab({ key, from: g.id });
  }

  /**
   * ワークスペース gid のタブ key を 1 つ下・上へ動かす（コマンド tab.move・Workspace switcher の J K）。端では動かさない。数えるのはサイドバーに出ているタブだけ。
   * 動かしたら true。
   */
  function moveTabByStep(
    gid: string,
    key: string,
    dir: "up" | "down",
  ): boolean {
    const g = untrack(gws).list.find((x) => x.id === gid);
    if (!g) return false;
    const next = moveTabStep(
      untrack(gws),
      gid,
      key,
      dir,
      visibleTabs(g, hasBrowserTab),
    );
    if (next) setGws(next);
    return next !== null;
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
    closeTermTabNow,
    setTabName,
    renameTabRow,
    tabRenameInit,
    renameTab,
    /** 名前をその場で変えているタブ（無ければ null） */
    renamingTab,
    tabRenameError,
    submitTabRename,
    cancelTabRename,
    /** タブを足すマシンを選んでいる途中の、足す先のワークスペースの id（無ければ null） */
    pickingFor,
    closeTabMachinePicker: () => setPickingFor(null),
    addWorkspaceTab,
    newTerminalTab,
    createNamedTerminalTab,
    openNewBrowserTabIn,
    /** Workspace switcher の、作るタブの種類の「DB」：接続を選ぶ Dialog を出す。選んだ接続のタブは、ワークスペース gid に入る（今いるワークスペースは、選ぶまで変えない） */
    openDbPickerIn: (gid: string) => deps.db.openPicker(gid),
    newBrowserTab,
    newBrowserTabAt,
    openBrowserTab,
    currentTabKey,
    stepTab,
    closeCurrentTab,
    /** タブ key を、ワークスペース gid の before の前へ動かす（ドラッグ。before が null なら最後へ）。今いるワークスペースは変えない */
    moveTabBefore(gid: string, key: string, before: string | null) {
      moveTab(key, gid, before, "stay");
    },
    /** 別のワークスペースへ移すタブ（移動先を選ぶ Dialog を出している。無ければ null） */
    movingTab,
    openTabMove,
    /** 移動先を選ぶ Dialog をやめる（キーをターミナルに戻す） */
    cancelTabMove() {
      setMovingTab(null);
      focusTerminal();
    },
    /**
     * Tab key を、Workspace gid の一番後ろへ移し、そこへ移って、その Tab を表示する（移動先を選ぶ Dialog で決めたときと同じ。
     * CLI の `kisui tab move --workspace`。#511）。動かせなかった（Tab か移動先が無い・もうそこにある）ら false
     */
    moveTabToWorkspace: (key: string, gid: string) =>
      moveTab(key, gid, null, "go"),
    /** 移動先を選ぶ Dialog で決めた。タブ key を、ワークスペース gid の一番後ろへ移し、そこへ移って、そのタブを出す */
    submitTabMove(key: string, gid: string) {
      setMovingTab(null);
      if (!moveTab(key, gid, null, "go")) focusTerminal();
    },
    /** tab.move：今出しているタブを 1 つ下・上へ動かす。端では動かさない */
    moveCurrentTab(dir: "up" | "down") {
      const g = currentGws();
      const key = currentTabKey();
      if (g && key) moveTabByStep(g.id, key, dir);
    },
    moveTabByStep,
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
