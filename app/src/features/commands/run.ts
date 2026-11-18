// コマンドの表（commands.ts）のコマンドを動かす。リーダーの葉と近道の両方がここに来る。
// キーの割り当ては表にあり、ここは動きだけを持つ。動きの中身は各機能（features/）の操作で、
// 窓を出す・キーを向けるなど画面の側ですることは CommandUi で受け取る。
import { T } from "../../i18n/index.ts";

import type { SplitDir } from "../../infrastructure/rpc/protocol.ts";
import type { Bookmarks } from "../browser/bookmarksStore.ts";
import type { Downloads } from "../browser/downloads.ts";
import type { BrowserOs } from "../browser/os.ts";
import type { Pages } from "../browser/pages.ts";
import { showTab } from "../browser/tabs.ts";
import type { BrowserTabs } from "../browser/tabsStore.ts";
import type { Failure, MascotStore } from "../mascot/mascotStore.ts";
import type { ReportProblem } from "../problem.ts";
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

/** コマンドが、画面の側に頼むこと（窓を出す・キーを向ける）。 */
export interface CommandUi {
  /** リサイズモードに入る・出る（Cmd+R / Ctrl+Shift+R） */
  toggleResizeMode(): void;
  /** サイドバーを開ける・閉じる（リーダーの b） */
  toggleSidebar(): void;
  /** マシンのダイアログ（リーダーの m）を出す */
  openMachines(): void;
  /** ワークスペースを切り替える窓（リーダーの w）を出す */
  openWorkspaceSwitcher(): void;
  /** クリップボードの履歴の窓を出す */
  openClipboardHistory(): void;
  /** キャラクターを選ぶ窓（リーダーの c s）を出す */
  openMascotPicker(): void;
  /** キーの一覧（`?`）を出す。フォーカスがある場所（ツリー・変更一覧・動画・画像）のキーも出す */
  openKeyList(): void;
  /** URL バー（新しいタブのページなら検索窓）にキーを向ける */
  focusUrlBar(): void;
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
  bookmarks: Bookmarks;
  downloads: Downloads;
  updates: Updates;
  mascot: MascotStore;
  scale: Scale;
  os: Pick<BrowserOs, "navTab" | "openTabDevtools">;
  setFocusError: ReportProblem;
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
  } = deps.pages;
  const { zoomed, termGroup, newTerminal, setZoom } = deps.terminals;
  const {
    newBrowserTab,
    removeTab,
    addWorkspaceTab,
    closeCurrentTab,
    stepTab,
  } = deps.tabs;
  const { setTabs } = deps.browserTabs;
  const { navTab, openTabDevtools } = deps.os;
  const { bookmarkPage } = deps.bookmarks;
  const { lastDownload, useDownload } = deps.downloads;
  const { changeScale } = deps.scale;

  /** 内蔵ブラウザのコマンド（リーダーの o）。 */
  function runBrowser(c: Command) {
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
          ui.forgetPageReturn();
          ui.focusUrlBar();
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
      case "browser.rename": {
        const t = currentTab();
        if (t) deps.tabs.openTabRename(t.id);
        break;
      }
      case "browser.bookmark": {
        const t = currentPage();
        if (t) bookmarkPage(t);
        break;
      }
      case "browser.bookmarks":
        deps.bookmarks.openDialog();
        break;
      case "browser.find": {
        const t = currentPage();
        if (t) openFind(t);
        break;
      }
      case "browser.copyUrl": {
        const t = currentPage();
        if (t) void ui.copyToClipboard(t.url);
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
        ui.toggleResizeMode();
        break;
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
        ui.openWorkspaceSwitcher();
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

  return { runCommand, chooseMascot };
}
