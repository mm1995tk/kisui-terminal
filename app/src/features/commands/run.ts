// コマンドの表（commands.ts）のコマンドを動かす。リーダーの葉と近道の両方がここに来る。
// キーの割り当ては表にあり、ここは動きだけを持つ。動きの中身は各機能（features/）の操作で、
// 窓を出す・キーを向けるなど画面の側ですることは CommandUi で受け取る。
import { T } from "../../i18n/index.ts";

import type { SplitDir } from "../../infrastructure/rpc/protocol.ts";
import type { Bookmarks } from "../browser/bookmarksStore.ts";
import type { Downloads } from "../browser/downloads.ts";
import type { BrowserOs, PasskeyLogin } from "../browser/os.ts";
import type { Pages } from "../browser/pages.ts";
import { isNewTab } from "../browser/newTab.ts";
import { showTab, type BrowserTab } from "../browser/tabs.ts";
import type { BrowserTabs } from "../browser/tabsStore.ts";
import { NEEDS_PAGE, type BrowserOp } from "../browser/window.ts";
import type { DbTabs } from "../db/controller.ts";
import type { Failure, MascotStore } from "../mascot/mascotStore.ts";
import type { ReportProblem } from "../problem.ts";
import type { Proxy } from "../proxy/controller.ts";
import type { Scale } from "../scale/controller.ts";
import type { ScaleAction } from "../scale/scale.ts";
import type { Terminals } from "../terminal/controller.ts";
import type { Direction } from "../terminal/grid.ts";
import { focusLastNotified } from "../terminal/lastNotified.ts";
import type { Updates } from "../updates/store.ts";
import type { Workspaces } from "../workspaces/controller.ts";
import type { Step } from "../workspaces/rows.ts";
import type { Tabs } from "../workspaces/tabs/controller.ts";
import type { Command } from "./commands.ts";
import { shownTabKind, type TabKind } from "./tabWindow.ts";

/**
 * ワークスペースの窓を開いたときの初めの状態。ws は左のワークスペースの列にキーを置く（リーダーの w）。tab は右のタブの列（t）。
 * newTab は、tab と同じ列で、タブの種類を選ぶ一覧を出しておく（n。#456）。
 */
export type SwitcherStart = "ws" | "tab" | "newTab";

/** コマンドが、画面の側に頼むこと（窓を出す・キーを向ける）。 */
export interface CommandUi {
  /** リサイズモードに入る・出る（Cmd+R / Ctrl+Shift+R） */
  toggleResizeMode(): void;
  /** サイドバーを開ける・閉じる（リーダーの b） */
  toggleSidebar(): void;
  /** マシンのダイアログ（リーダーの m）を出す */
  openMachines(): void;
  /** ワークスペースの窓を出す（リーダーの w は ws、t は tab、n は newTab） */
  openWorkspaceSwitcher(start: SwitcherStart): void;
  /** 今出しているタブの種類 kind の窓を出す（リーダーの a。#457。窓を出し分けるのは ui/main-window/tab-window/TabWindows.tsx） */
  openTabWindow(kind: TabKind): void;
  /** クリップボードの履歴の窓を出す */
  openClipboardHistory(): void;
  /** キャラクターを選ぶ窓（リーダーの c s）を出す */
  openMascotPicker(): void;
  /** キーの一覧（`?`）を出す。フォーカスがある場所（ツリー・変更一覧・動画・画像）のキーも出す */
  openKeyList(): void;
  /** URL バー（新しいタブのページなら検索窓）にキーを向ける */
  focusUrlBar(): void;
  /** サイドバーの DB のタブの木にキーを向ける（#374。閉じているサイドバーは開く） */
  focusDbTree(): void;
  /** ページから押したときに覚えた「キーを戻す先」を捨てる */
  forgetPageReturn(): void;
  /** OS のクリップボードに入れ、書けたときだけ「コピーしました」を出す */
  copyToClipboard(text: string): Promise<void>;
  /** 右下の知らせのうち、いちばん新しいものを閉じる */
  dismissLastNotice(): void;
}

/** createCommandRunner が返す持ち物。 */
export type CommandRunner = ReturnType<typeof createCommandRunner>;

/** コマンドを動かす関数（runCommand）を作る。コマンドの id を、各機能の操作か、画面の側に頼むこと（CommandUi）に振り分ける。 */
export function createCommandRunner(deps: {
  workspaces: Workspaces;
  tabs: Tabs;
  terminals: Terminals;
  browserTabs: BrowserTabs;
  pages: Pages;
  db: Pick<
    DbTabs,
    | "shownDbTab"
    | "openPicker"
    | "reloadCatalog"
    | "openExport"
    | "openHistory"
    | "stepPage"
    | "stepResultTab"
    | "closeResult"
    | "reloadStructure"
    | "showView"
    | "openElevate"
    | "endElevation"
  >;
  bookmarks: Bookmarks;
  downloads: Downloads;
  updates: Updates;
  mascot: MascotStore;
  scale: Scale;
  proxy: Pick<Proxy, "openPanel" | "closePanel" | "stopCurrent" | "toggleHold">;
  os: Pick<BrowserOs, "openTabDevtools" | "startPasskeyLogin">;
  setFocusError: ReportProblem;
  /** 少しの間だけ出る短い知らせ */
  showToast: (text: string) => void;
  /** 今使っているペイン（ブラウザのタブを出していればそのページ）にキーを向ける */
  focusTerminal: () => void;
  ui: CommandUi;
}) {
  const { setFocusError, focusTerminal, ui, updates } = deps;
  const {
    focus,
    currentGws,
    cannot,
    stepWs,
    moveWs,
    newWorkspace,
    closeWorkspace,
    openWorkspaceRename,
  } = deps.workspaces;
  const {
    shownBrowserTab,
    currentTab,
    currentPage,
    openUrlFor,
    openFind,
    changePageZoom,
    navPage,
    stopPage,
  } = deps.pages;
  const { zoomed, termGroup, newTerminal, setZoom } = deps.terminals;
  const { newBrowserTab, addWorkspaceTab, closeCurrentTab, stepTab } =
    deps.tabs;
  const { setTabs } = deps.browserTabs;
  const { openTabDevtools, startPasskeyLogin } = deps.os;
  const { bookmarkPage } = deps.bookmarks;
  const { lastDownload, useDownload } = deps.downloads;
  const { changeScale } = deps.scale;

  /**
   * パスキーを待たずに、タブのサイトを外のブラウザで開き、そのサイトのログインを待つ（#276。ブラウザのタブの窓の `s`・設定の近道の browser.login）。
   * 許可サイト（passkey_sites）か・シークレットのタブかは殻が決め、使えなければ理由をお知らせに出す。
   */
  function loginExternally(tab: string, url: string) {
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      // URL の形でなければそのまま出す
    }
    // 使えないときの理由（答えを足したら、ここに足し忘れると型で分かる）
    const reasons: Record<Exclude<PasskeyLogin, "opened">, () => string> = {
      incognito: () => T("cannot.browser.login.incognito"),
      "no-sites": () => T("cannot.browser.login.noSites"),
      "not-allowed": () => T("cannot.browser.login.notAllowed", { host }),
    };
    startPasskeyLogin(tab).then(
      (r) => {
        if (r === "opened") deps.showToast(T("toast.browser.login"));
        else cannot(T("cannot.browser.login.title"), reasons[r]());
      },
      (e: unknown) =>
        setFocusError({
          title: T("cannot.browser.login.title"),
          error: e instanceof Error ? e.message : String(e),
        }),
    );
  }

  /**
   * ブラウザのタブ t のページに、操作 op を行う。設定の近道（browser.*）と、ブラウザのタブの窓（リーダーの a。#459）の両方がここを通る
   * （処理を 2 か所に書かない）。t を決めるのは呼ぶ側：近道は今出しているタブ、窓は開いたときのタブ。
   * ページが要る操作（NEEDS_PAGE）を新しいタブのページに頼まれたら、何もしない（近道は currentPage が先に断り、窓は行に理由を出している）。
   */
  function browserOn(t: BrowserTab, op: BrowserOp) {
    if (NEEDS_PAGE.has(op) && isNewTab(t)) return;
    switch (op) {
      case "url":
        // ページから押したときに覚えた「戻す先」を捨てる（検索の欄と同じ。openFind）
        ui.forgetPageReturn();
        ui.focusUrlBar();
        break;
      case "back":
      case "forward":
      case "reload":
        navPage(t.id, op);
        break;
      case "stop":
        // 読み込み中でなければ何もしない（ページの Esc と同じ）
        stopPage(t.id);
        break;
      case "external":
        openUrlFor(t.target, t.url);
        break;
      case "bookmark":
        bookmarkPage(t);
        break;
      case "bookmarks":
        deps.bookmarks.openDialog();
        break;
      case "find":
        openFind(t);
        break;
      case "copyUrl":
        void ui.copyToClipboard(t.url);
        break;
      case "devtools":
        openTabDevtools(t.id).catch((e: unknown) =>
          setFocusError({
            title: T("err.devtools"),
            error: e instanceof Error ? e.message : String(e),
          }),
        );
        break;
      case "login":
        loginExternally(t.id, t.url);
        break;
    }
  }

  /** ブラウザのタブ tab（id）のページに、操作 op を行う（ブラウザのタブの窓。#459）。タブがもう無ければ何もしない。 */
  function runBrowserOn(tab: string, op: BrowserOp) {
    const t = deps.browserTabs.tabs().tabs.find((x) => x.id === tab);
    if (t) browserOn(t, op);
  }

  /**
   * 内蔵ブラウザのコマンド（設定の近道だけで使う browser.*。#459 までのリーダーの o のグループと、#456 までの o n・o N）。
   * 今出しているブラウザのタブに行う。
   */
  function runBrowser(c: Command) {
    switch (c.id) {
      case "browser.new":
      case "browser.incognito": {
        const g = currentGws();
        if (!g)
          cannot(T("cannot.browser.open.title"), T("cannot.browser.open.text"));
        else newBrowserTab(g, c.id === "browser.incognito");
        return;
      }
      // 閉じる・名前を変えるは、タブ共通の処理（tab.close・tab.rename と同じ）。ブラウザのタブを出しているときだけ動かす
      // （設定の近道に書いた人の設定を壊さないために残したコマンド。#459）
      case "browser.close":
        // 出していたタブを閉じたら、キーをターミナル（次に出すタブ）に向ける（closeTabRow）
        if (currentTab()) closeCurrentTab();
        return;
      case "browser.rename":
        if (currentTab()) deps.tabs.renameCurrentTab();
        return;
      // ブックマークの一覧は、今のタブが無くても開ける（開くと、今のワークスペースの新しいタブに出る）
      case "browser.bookmarks":
        deps.bookmarks.openDialog();
        return;
    }
    const op = c.id.slice("browser.".length) as BrowserOp;
    const t = NEEDS_PAGE.has(op) ? currentPage() : currentTab();
    if (t) browserOn(t, op);
  }

  /**
   * 今出しているタブの種類（無ければ undefined）。リーダーの a で開く窓の種類を決めるのも、
   * 出している窓を閉じるか（タブの種類が変わったか）を画面が決めるのも、これを使う（決め方を 2 か所に書かない）。
   */
  const shownKind = (): TabKind | undefined =>
    shownTabKind({
      browser: !!shownBrowserTab(),
      db: !!deps.db.shownDbTab(),
      terminal: !!focus(),
    });

  /** キャラクターの読み直し・選び直しの結果。できなかったときは、その理由を伝える */
  function failed(f: Failure) {
    if (f) cannot(f.title, f.error);
  }

  /** リーダーの `c s` の窓で選んだキャラクターに替える。できなかったときは、その理由を伝える */
  function chooseMascot(name: string) {
    void deps.mascot.choose(name).then(failed);
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
    // ターミナルのタブが無いワークスペース（ブラウザのタブだけ・空）には、ペインが無い（focus が null）
    if (c.id.startsWith("pane.") && currentGws() && !f) {
      cannot(T("cannot.pane.none.title"), T("cannot.pane.none.text"));
      return;
    }
    // ページのタブ（ブラウザのタブ・DB のタブ）を出している間のペインの操作は、まずグリッドに戻す（見えないペインは動かさない）。
    // ペインを閉じる（Cmd+W・設定の近道の pane.close）は、戻すだけで閉じない（どのペインが閉じるか見えないまま閉じないため）
    if (
      c.id.startsWith("pane.") &&
      c.id !== "pane.resize" &&
      f &&
      (shownBrowserTab() || deps.db.shownDbTab())
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
        ui.toggleResizeMode();
        break;
      case "db.open":
        deps.db.openPicker();
        break;
      case "db.tree":
      case "db.refresh": {
        // サイドバーの木（#348・#374）の操作：DB のタブを出している間だけ
        const tab = deps.db.shownDbTab();
        if (!tab) {
          cannot(T("cannot.dbTree.title"), T("cannot.dbTree.text"));
          break;
        }
        // db.tree は木にキーを向ける（キーだけで j k と Enter に移れる。閉じているサイドバーは開く）。入力欄へは木の Esc で戻る
        if (c.id === "db.tree") {
          ui.focusDbTree();
          break;
        }
        if (c.id === "db.refresh") {
          void deps.db.reloadCatalog(tab.id);
          // 選んだテーブルの構造（#379）も聞き直す
          deps.db.reloadStructure(tab.id);
        }
        focusTerminal();
        break;
      }
      case "db.export":
      case "db.history": {
        // 結果の書き出しと履歴の呼び出し（#349）：DB のタブを出している間だけ
        const tab = deps.db.shownDbTab();
        if (!tab) {
          cannot(T("cannot.dbTree.title"), T("cannot.dbTree.text"));
          break;
        }
        if (c.id === "db.history") {
          void deps.db.openHistory(tab.id);
          break;
        }
        if (!deps.db.openExport(tab.id))
          cannot(T("cannot.dbExport.title"), T("cannot.dbExport.text"));
        break;
      }
      case "db.view": {
        // 結果の場所の「データ」と「Structure」の切り替え（#379）：木でテーブルを選んだ DB のタブを出している間だけ
        const tab = deps.db.shownDbTab();
        if (!tab) {
          cannot(T("cannot.dbTree.title"), T("cannot.dbTree.text"));
          break;
        }
        if (!deps.db.showView(tab.id))
          cannot(T("cannot.dbView.title"), T("cannot.dbView.text"));
        break;
      }
      case "db.elevate":
      case "db.elevateEnd": {
        // 権限を、時間を決めて強める・時間の前に戻す（#383）：DB のタブを出している間だけ。その接続（の変種）の権限に行う
        const tab = deps.db.shownDbTab();
        if (!tab) {
          cannot(T("cannot.dbTree.title"), T("cannot.dbTree.text"));
          break;
        }
        if (c.id === "db.elevate") void deps.db.openElevate(tab.id);
        else void deps.db.endElevation(tab.id);
        break;
      }
      case "db.page": {
        // 結果のページ送り（#373）：DB のタブを出している間だけ。実行している間に押した分は、結果が来てから順に送る（controller.ts の queuedSteps）
        const tab = deps.db.shownDbTab();
        if (!tab) {
          cannot(T("cannot.dbTree.title"), T("cannot.dbTree.text"));
          break;
        }
        const step = c.arg === "prev" ? "prev" : "next";
        const why = deps.db.stepPage(tab.id, step);
        if (why === "none")
          cannot(T("cannot.dbPage.title"), T("cannot.dbPage.none"));
        else if (why === "edge")
          cannot(
            T("cannot.dbPage.title"),
            T(
              step === "next" ? "cannot.dbPage.noNext" : "cannot.dbPage.noPrev",
            ),
          );
        break;
      }
      case "db.result":
      case "db.closeResult": {
        // 結果のタブ（#404）の切り替えと、閉じる：DB のタブを出している間だけ。端のタブ・タブが無いときは何もしない
        const tab = deps.db.shownDbTab();
        if (!tab) {
          cannot(T("cannot.dbTree.title"), T("cannot.dbTree.text"));
          break;
        }
        if (c.id === "db.result")
          deps.db.stepResultTab(tab.id, c.arg === "prev" ? -1 : 1);
        else deps.db.closeResult(tab.id);
        break;
      }
      case "workspace.nth":
        // サイドバーの上から順に（1 列の並びで）。足りなければ何もしない
        deps.workspaces.goNth(c.arg as number);
        break;
      case "workspace.step":
        stepWs(c.arg as Step);
        break;
      case "workspace.move":
        moveWs(c.arg as "up" | "down");
        break;
      case "workspace.last":
        deps.workspaces.goLast();
        break;
      case "workspace.new":
        newWorkspace();
        break;
      case "workspace.switch":
        ui.openWorkspaceSwitcher(
          c.arg === "tab" || c.arg === "newTab" ? c.arg : "ws",
        );
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
      case "tab.move":
        deps.tabs.moveCurrentTab(c.arg as "up" | "down");
        break;
      case "tab.nth":
        // サイドバーの上から n 番目（出ているタブだけを数える）
        deps.tabs.goNthTab(c.arg as number);
        break;
      case "tab.rename":
        deps.tabs.renameCurrentTab();
        break;
      case "tab.moveTo":
        deps.tabs.openTabMove();
        break;
      case "tab.window": {
        // 今出しているタブの種類の窓を開く。ターミナルのタブの窓を、DB・ブラウザのタブやタブの無い所で開かない（種類ごとに、その種類の窓だけ）
        const kind = shownKind();
        if (!kind)
          cannot(T("cannot.tabWindow.title"), T("cannot.tabWindow.noTab"));
        else ui.openTabWindow(kind);
        break;
      }
      case "machine.dialog":
        ui.openMachines();
        break;
      case "sidebar.toggle":
        ui.toggleSidebar();
        break;
      case "clipboard.history":
        ui.openClipboardHistory();
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
        if (updates.info()) void updates.install();
        else cannot(T("cannot.update.title"), T("cannot.update.text"));
        break;
      case "notice.dismiss":
        if (updates.info()) updates.dismiss();
        else ui.dismissLastNotice();
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
      case "proxy.panel":
        // パネルを開く（まだなら、今のタブをプロキシに通し始める）。もう開いていれば、キーをパネルに向ける
        void deps.proxy.openPanel();
        break;
      case "proxy.close":
        deps.proxy.closePanel();
        break;
      case "proxy.stop":
        void deps.proxy.stopCurrent();
        break;
      case "proxy.hold":
        // 今のタブの要求を、行き先に送る前に止める・止めるのをやめる（#411）
        void deps.proxy.toggleHold();
        break;
      case "mascot.select":
        ui.openMascotPicker();
        break;
      case "mascot.reload":
        void deps.mascot.reloadCurrent().then(failed);
        break;
      case "help.keys":
        ui.openKeyList();
        break;
    }
  }

  return { runCommand, runBrowserOn, chooseMascot, shownTabKind: shownKind };
}
