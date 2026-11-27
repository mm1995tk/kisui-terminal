// メインウィンドウの機能の持ち物（各 controller）を作って、互いをつなぐ。
// 持ち物どうしは互いを呼ぶ（接続の知らせでフォーカスを直す、タブを閉じたらワークスペースを移る、など）。
// 先に作る側には、後で作る側を呼ぶ関数を渡す（呼ばれるのは、全部を作り終えたあと）。
// 外への頼みの本物（FeaturePorts）と、画面の側に頼むこと（FeatureUi・CommandUi）は、呼ぶ側（ui/main-window/page.tsx）が渡す。
// ここには動きを書かない。画面にも Tauri にも触らない。
import { createSignal } from "solid-js";

import { createBookmarks } from "./browser/bookmarksStore.ts";
import { watchCookieMismatch } from "./browser/cookieMismatch.ts";
import { createDownloads } from "./browser/downloads.ts";
import type { BrowserOs } from "./browser/os.ts";
import { createPages } from "./browser/pages.ts";
import { createBrowserTabs } from "./browser/tabsStore.ts";
import { createChanges } from "./changes/controller.ts";
import { createCommandRunner, type CommandUi } from "./commands/run.ts";
import { createDbTabs } from "./db/controller.ts";
import type { DbConfigFiles } from "./db/connectionForm.ts";
import type { SaveTextFile } from "./db/export.ts";
import { createFileTree } from "./file-tree/controller.ts";
import type { KeyValueStore } from "./keyValueStore.ts";
import type { MascotOs } from "./mascot/mascot.ts";
import { createMascotStore } from "./mascot/mascotStore.ts";
import type { Problem } from "./problem.ts";
import { createScale } from "./scale/controller.ts";
import type { ApplyScale } from "./scale/scale.ts";
import { createSessions } from "./sessions/controller.ts";
import {
  anyAskEach,
  askPaneOp,
  askPaneOpen,
  cancelPaneApproval,
  cancelPaneApprovalsFrom,
  markAskEach,
  mustAskEach,
} from "./sessions/paneApproval.ts";
import { onPaneGrantEnd, paneGrantActive } from "./sessions/paneGrant.ts";
import { createPaneRelay } from "./sessions/paneRelay.ts";
import { createWindowRun } from "./commands/windowRun.ts";
import type { ConfigMachine } from "./sessions/machines.ts";
import type { TermDefaults } from "./sessions/termDefaults.ts";
import type { ShellApi } from "./sessions/shell.ts";
import { createTerminals } from "./terminal/controller.ts";
import type { OpenUrlExternally } from "./terminal/urlOpen.ts";
import { createUpdates, type UpdatesOs } from "./updates/store.ts";
import { createWorkspaces } from "./workspaces/controller.ts";
import { routePaneEvent } from "./workspaces/paneEvents.ts";
import { createPrimaryShj } from "./workspaces/primaryShj.ts";
import { createProxy, type Proxy } from "./proxy/controller.ts";
import { createTabs } from "./workspaces/tabs/controller.ts";
import { createPaneOpen } from "./workspaces/tabs/paneOpen.ts";
import { createTabCommands } from "./workspaces/tabs/tabCommands.ts";
import type { WorkspaceId } from "../infrastructure/rpc/protocol.ts";

/** 機能が外に頼むこと（本物は infrastructure/。index.tsx が組み立てる）。 */
export interface FeaturePorts {
  /** 接続（ssh・kisui attach）と設定ファイル */
  shell: ShellApi;
  /** 小さな記録の置き場（使えない環境では undefined。そのときは覚えない） */
  store: KeyValueStore | undefined;
  /** 内蔵ブラウザのタブ */
  browser: BrowserOs;
  /** 外部ブラウザ */
  openUrl: OpenUrlExternally;
  /** Window の中の画面全体の大きさ */
  applyScale: ApplyScale;
  /** キャラクター */
  mascot: MascotOs;
  /** 新しい版 */
  updates: UpdatesOs;
  /** DB のタブの結果の、ファイルへの書き出し（保存のダイアログ。#349） */
  exportFile: SaveTextFile;
  /** 手元の PC の config.local.toml の DB の接続を読む・書く（#486） */
  dbConfig: DbConfigFiles;
}

/** 機能が、画面の側に頼むこと（キーを向ける・スクロールを戻す・短い知らせを出す）。 */
export interface FeatureUi {
  /** 今使っているペイン（ブラウザのタブを出していればそのページ）にキーを向ける */
  focusTerminal(): void;
  /** ページから押したときに覚えた「キーを戻す先」を捨てる */
  forgetPageReturn(): void;
  /** 閉じているサイドバーを開ける */
  revealSidebar(): void;
  /** ツリーの描き直しのあとで、スクロールの位置を top に戻す */
  restoreTreeScroll(top: number): void;
  /** ページ内検索の欄の入力欄にキーを向ける */
  focusFind(): void;
  /** shj が引数なしで起動した直後の、ツリーへのフォーカスの頼み */
  requestStartFocus(target: string, id: WorkspaceId): void;
  /** サイドバーのファイルツリーにキーを向ける */
  focusExplorer(target: string, id: WorkspaceId): void;
  /** サイドバーの CHANGES にキーを向ける */
  focusChanges(target: string, id: WorkspaceId): void;
  /** OS のクリップボードに入れ、書けたときだけ「コピーしました」を出す */
  copyToClipboard(text: string): Promise<void>;
  /** 変えた大きさを少しの間見せる */
  showScale(v: number): void;
  /** 少しの間だけ出る短い知らせ */
  showToast(text: string): void;
  /** プロキシのパネル（#409）にキーを向ける */
  focusProxyPanel(): void;
}

/** createFeatures が返す、メインウィンドウの機能の持ち物の全部。 */
export type Features = ReturnType<typeof createFeatures>;

/** メインウィンドウの機能の持ち物を全部作り、互いをつないで返す。Solid の所有者（コンポーネントか createRoot）の中で 1 回だけ呼ぶ。 */
export function createFeatures(deps: {
  ports: FeaturePorts;
  /** 手元の設定ファイルで決めたマシン */
  config: ConfigMachine[];
  /** 手元のマシンの、新しいターミナルが始まるフォルダとシェル（設定の [server] start_dir・shell。#485） */
  localTerminal?: TermDefaults | null;
  /** 起動のときから出しておく、できなかったこと（前の版の、Window で足したマシンの記録を移せなかった、など） */
  startupProblem?: Problem;
  /** 内蔵ブラウザのタブを使うか（設定の [gui.browser] enabled。#202） */
  browser: boolean;
  /** macOS か */
  mac: boolean;
  ui: FeatureUi;
  commandUi: CommandUi;
}) {
  const { ports, browser, ui } = deps;
  const store = ports.store;
  // ワークスペースに移れなかった・ファイルを開けなかったなど、できなかったことの知らせ（見出しと本文）。無ければ null
  const [focusError, setFocusError] = createSignal<Problem | null>(
    deps.startupProblem ?? null,
  );
  const focusTerminal = () => ui.focusTerminal();
  const forgetPageReturn = () => ui.forgetPageReturn();

  // プロキシの持ち物（下で作る）。サイドバーの行は、作る前から引かれるので、作ったあとに知らせる
  const [proxyMade, setProxyMade] = createSignal<Proxy | undefined>();
  const updates = createUpdates(ports.updates);
  const mascot = createMascotStore(ports.mascot);
  const sessions = createSessions({
    api: ports.shell,
    store,
    config: deps.config,
    localTerminal: deps.localTerminal,
    report: (p) => setFocusError(p),
    hooks: {
      treeChanged: () => fileTree.changed(),
      termChanged: () => terminals.changed(),
      firstList: (target, list) => workspaces.firstList(target, list),
      shjFocus: () => workspaces.shjFocusChanged(),
      pane: (target, ev, s) =>
        routePaneEvent(
          {
            paneShow: terminals.paneShow,
            paneShowExtra: terminals.paneShowExtra,
            requestStartFocus: (t, id) => ui.requestStartFocus(t, id),
            focusExplorer: (t, id) => ui.focusExplorer(t, id),
            focusChanges: (t, id) => ui.focusChanges(t, id),
            openUrlFor: pages.openUrlFor,
            checkNow: updates.checkNow,
            openTab: (t, rq) => openTab(t, rq),
            relay: (from, m, rq, by) => relay(from, m, rq, by),
            relayCancel: cancelPaneApproval,
            dbPropose: (t, rq) => db.propose(t, rq),
            dbProposeCancel: (t, id) => db.cancelPropose(t, id),
            windowRun: (from, rq) => windowRun.run(from, rq),
            windowRunCancel: (from, id) => windowRun.cancel(from, id),
            zoomWs: terminals.zoomWs,
          },
          target,
          ev,
          s,
        ),
    },
  });
  const terminals = createTerminals({
    sessions: sessions.sessions,
    workspaces: sessions.workspaces,
    termGroups: sessions.termGroups,
    focus: () => workspaces.focus(),
    focusTerminal,
  });
  const browserTabs = createBrowserTabs({ os: ports.browser });
  const workspaces = createWorkspaces({
    store,
    browser,
    sessions,
    browserTabs,
    closeTabView: ports.browser.closeTabView,
    setFocusError,
    focusTerminal,
    forgetPageReturn,
    revealSidebar: () => ui.revealSidebar(),
    proxiedTerm: (target, ws) =>
      proxyMade()?.isProxiedTerm(target, ws) ?? false,
  });
  const db = createDbTabs({
    store,
    sessions,
    workspaces,
    browserTabs,
    activateTab: (gid, ref) => tabs.activateTab(gid, ref),
    focusTerminal,
    saveFile: ports.exportFile,
    copyToClipboard: (text) => ui.copyToClipboard(text),
    showToast: (text) => ui.showToast(text),
    configDb: ports.dbConfig,
  });
  const openTab = createPaneOpen({
    browser,
    sessions,
    gws: workspaces.gws,
    setGws: workspaces.setGws,
    justCreated: workspaces.justCreated,
  });
  // ssh 先のマシンから手元の PC への頼みは、人が時間を決めて許している間だけ通し、ペインを作る頼みは人に聞く
  const relay = createPaneRelay({
    sessions,
    openTab,
    local: {
      granted: paneGrantActive,
      askOpen: askPaneOpen,
      askOp: askPaneOp,
      anyAskEach,
      mustAskEach,
      markAskEach,
    },
  });
  // 許可が終わったら（時間が来た・途中で終えた）、そのマシンの、聞いている途中の頼みを断る
  onPaneGrantEnd(cancelPaneApprovalsFrom);
  const askPrimaryShj = createPrimaryShj({
    sessions: sessions.sessions,
    workspaces: sessions.workspaces,
    isSwitching: workspaces.isSwitching,
    extraShown: terminals.extraShown,
    termGroup: terminals.termGroup,
    focusTerminal,
    setFocusError,
  });
  const fileTree = createFileTree({
    sessions: sessions.sessions,
    workspaces: sessions.workspaces,
    trees: sessions.trees,
    focus: workspaces.focus,
    folderOf: workspaces.folderOf,
    rootOf: workspaces.rootOf,
    walking: workspaces.walking,
    askPrimaryShj,
    copyToClipboard: (text) => ui.copyToClipboard(text),
    restoreScroll: (top) => ui.restoreTreeScroll(top),
    setFocusError,
  });
  const changes = createChanges({
    sessions: sessions.sessions,
    workspaces: sessions.workspaces,
    focus: workspaces.focus,
    rootOf: workspaces.rootOf,
    walking: workspaces.walking,
    isSwitching: workspaces.isSwitching,
    askPrimaryShj,
    termGroup: terminals.termGroup,
    focusTerminal,
    setFocusError,
  });
  const pages = createPages({
    os: ports.browser,
    browser,
    mac: deps.mac,
    browserTabs,
    workspaces,
    openUrlExternally: ports.openUrl,
    removeTab: (id, back) => tabs.removeTab(id, back),
    setFocusError,
    focusTerminal,
    forgetPageReturn,
    focusFind: () => ui.focusFind(),
    showScale: (v) => ui.showScale(v),
  });
  const bookmarks = createBookmarks({
    os: ports.browser,
    openTab: (url, title) => tabs.openBrowserTab(url, title),
    newTabPageId: pages.newTabPageId,
    showToast: (text) => ui.showToast(text),
    setFocusError,
    cannot: workspaces.cannot,
    focusTerminal,
  });
  const downloads = createDownloads({
    os: ports.browser,
    browser,
    setFocusError,
  });
  watchCookieMismatch({ os: ports.browser, browser, setFocusError });
  const tabs = createTabs({
    sessions,
    workspaces,
    browserTabs,
    pages,
    db,
    setFocusError,
    focusTerminal,
    revealSidebar: () => ui.revealSidebar(),
  });
  // Window に頼む、Pane の中のコマンド（`kisui tab` など。#511）。CLI を足すときは、受け持ちの表をここに足す
  const windowRun = createWindowRun([
    createTabCommands({
      sessions,
      gws: workspaces.gws,
      rows: workspaces.rows,
      tabs,
      browser,
      granted: paneGrantActive,
      anyAskEach,
    }),
  ]);
  const proxy = createProxy({
    sessions,
    workspaces,
    pages,
    db,
    browserTabs,
    setFocusError,
    focusTerminal,
    forgetPageReturn,
    focusPanel: () => ui.focusProxyPanel(),
  });
  setProxyMade(proxy);
  const scale = createScale({
    store,
    applyScale: ports.applyScale,
    showScale: (v) => ui.showScale(v),
  });
  const commands = createCommandRunner({
    workspaces,
    tabs,
    terminals,
    browserTabs,
    pages,
    db,
    bookmarks,
    downloads,
    updates,
    mascot,
    scale,
    proxy,
    os: ports.browser,
    setFocusError,
    showToast: (text) => ui.showToast(text),
    focusTerminal,
    ui: deps.commandUi,
  });

  return {
    /** できなかったことの知らせ（無ければ null） */
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
  };
}
