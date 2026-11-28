// 右のペイン。フォーカスしているワークスペースのターミナル（先頭がプライマリ）を、kisui serve が持つ分割の木の通りに並べる（terminal/）。
// 内蔵ブラウザのタブを出していれば、その場所すべてがそのページになる（browser/。URL バー・新しいタブのページ・ページ内検索もここに重ねる）。
// 空のワークスペース（#307）を選んでいる間は、タブが無いことを伝える画面（EmptyWorkspace.tsx）で覆う。
// DB のタブ（#347）を出している間は、その画面（db/DbTabView.tsx）で覆う。
// プロキシのパネル（#409）を開いているタブでは、場所を左右に分け、右にパネル（proxy/ProxyPanel.tsx）を出す（左のターミナル・ページは縮む）。
import { Show, type JSX } from "solid-js";

import type { Bookmarks } from "../../../features/browser/bookmarksStore.ts";
import type { Pages } from "../../../features/browser/pages.ts";
import type { BrowserTabs } from "../../../features/browser/tabsStore.ts";
import type { DbTabs } from "../../../features/db/controller.ts";
import { dbLabel } from "../../../features/workspaces/model.ts";
import {
  interceptKeys,
  leaderKeyName,
} from "../../../features/commands/commands.ts";
import { IS_MAC } from "../../../features/commands/guiKeys.ts";
import type { ReportProblem } from "../../../features/problem.ts";
import type { Proxy } from "../../../features/proxy/controller.ts";
import type { Terminals } from "../../../features/terminal/controller.ts";
import type { FocusUi } from "../focus.ts";
// CSS を持つ部品の import は、この順（ブラウザ → リーダーの案内 → ターミナル → 空のワークスペース → DB のタブ → プロキシのパネル）を変えない（理由は page.tsx）
import { BrowserArea } from "./browser/BrowserArea.tsx";
import { FindBar } from "./browser/FindBar.tsx";
import { NewTabPage } from "./browser/NewTabPage.tsx";
import { UrlBar } from "./browser/UrlBar.tsx";
import { leaderPath } from "../commands/LeaderMenu.tsx";
import { TerminalGrid } from "./terminal/TerminalGrid.tsx";
import { EmptyWorkspace } from "./EmptyWorkspace.tsx";
import { DbTabView } from "./db/DbTabView.tsx";
import { openKeyList } from "../commands/KeyListDialog.tsx";
import { ProxyPanel } from "./proxy/ProxyPanel.tsx";

/** 右のペイン。ターミナルのグリッドと、内蔵ブラウザを使うときはブラウザのページ（URL バー・新しいタブのページ・ページ内検索）を出す。 */
export function ContentArea(props: {
  /** ペインの要素を受け取る */
  ref: (el: HTMLDivElement) => void;
  /** 内蔵ブラウザのタブを使うか（設定の [gui.browser] enabled。#202） */
  browser: boolean;
  /** 空のワークスペース（タブが 1 つも無い。#307）を選んでいるか。タブが無いことを伝える画面を出す */
  empty: boolean;
  terminals: Terminals;
  browserTabs: BrowserTabs;
  pages: Pages;
  db: DbTabs;
  /** プロキシのパネル（#409） */
  proxy: Proxy;
  /** マシンの名前 */
  labelOf: (target: string) => string;
  bookmarks: Bookmarks;
  focusUi: FocusUi;
  /** リサイズモードで選んでいる、ペインどうしの Pane border */
  litSplit: string | undefined;
  /** フォーカスしているワークスペースのマシンの色 */
  accent: string | undefined;
  /** 画面全体の大きさ（webview の zoom） */
  scale: () => number;
  setFocusError: ReportProblem;
}): JSX.Element {
  // 部品は作り直さないので、持ち物は 1 回だけ取り出す
  const {
    termList,
    termLayout,
    termGroup,
    termActive,
    termExtras,
    termActiveExtra,
    readExtra,
    zoomed,
  } = props.terminals;
  const { tabs } = props.browserTabs;
  const {
    shownBrowserTab,
    pageTabId,
    newTabPageId,
    findTab,
    resolveFor,
    submitUrlBar,
    navPage,
    stopPage,
    closeFind,
    openUrl,
  } = props.pages;
  const { bookmarks, firefoxBookmarks } = props.bookmarks;
  const { focusTerminal } = props.focusUi;
  return (
    <div
      class="main"
      ref={props.ref}
      data-proxy-panel={props.proxy.panel() ? "" : undefined}
    >
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
        litBorder={props.litSplit}
        accent={props.accent}
        onActivate={(i) => termGroup()?.setActive(i)}
        onUrl={openUrl}
        focusRef={(f) => props.focusUi.setTerminalFocus(f)}
      />
      <Show when={props.browser}>
        <BrowserArea
          tabs={tabs().tabs}
          shown={shownBrowserTab()}
          zoom={props.scale}
          keys={() => interceptKeys(IS_MAC)}
          resolve={resolveFor}
          onRetry={(id) => navPage(id, "reload")}
          onError={(title, error) => props.setFocusError({ title, error })}
          focusRef={(f) => props.focusUi.setBrowserPageFocus(f)}
          leaderOpen={() => leaderPath() !== null}
        >
          <Show when={pageTabId()} keyed>
            {(id) => (
              <UrlBar
                url={shownBrowserTab()?.url ?? ""}
                onSubmit={(url) => submitUrlBar(id, url)}
                onCancel={() => focusTerminal()}
                onNav={(action) => {
                  navPage(id, action);
                  focusTerminal();
                }}
                canGoBack={shownBrowserTab()?.history?.back ?? false}
                canGoForward={shownBrowserTab()?.history?.forward ?? false}
                loading={shownBrowserTab()?.loading?.progress}
                onStop={() => {
                  stopPage(id);
                  focusTerminal();
                }}
                focusRef={(f) => props.focusUi.setUrlBarFocus(f)}
              />
            )}
          </Show>
          <Show when={newTabPageId()} keyed>
            {(id) => (
              <NewTabPage
                incognito={!!shownBrowserTab()?.incognito}
                own={bookmarks()}
                firefox={firefoxBookmarks()}
                failed={props.bookmarks.failed()}
                onOpen={(url) => submitUrlBar(id, url)}
                focusRef={(f) => props.focusUi.setUrlBarFocus(f)}
              />
            )}
          </Show>
          <Show when={findTab()} keyed>
            {(id) => (
              <FindBar
                tab={id}
                onClose={closeFind}
                focusRef={(f) => props.focusUi.setFindFocus(f)}
              />
            )}
          </Show>
        </BrowserArea>
      </Show>
      <Show when={props.db.shownDbTab()?.id} keyed>
        {(id) => {
          const db = props.db;
          const ref = () => db.refOf(id);
          return (
            <DbTabView
              connection={dbLabel(ref()?.connection ?? "", ref()?.variant)}
              machine={props.labelOf(ref()?.target ?? "")}
              mac={IS_MAC}
              sql={db.draftOf(id)}
              onSql={(sql) => db.setDraft(id, sql)}
              run={db.runOf(id)}
              onRun={(text, from, to, into) =>
                void db.runSelection(id, text, from, to, into)
              }
              onPage={(step) => void db.stepPage(id, step)}
              onSort={(column) => void db.sortBy(id, column)}
              onCancel={() => db.cancel(id)}
              onCopyCells={db.copyCells}
              onResult={(tab) => db.showResult(id, tab)}
              onStepResult={(step) => db.stepResultTab(id, step)}
              onCloseResult={(tab) => void db.closeResult(id, tab)}
              onKeepResult={(tab) => db.keepResult(id, tab)}
              elevated={db.elevatedOf(id)}
              structure={db.structureOf(id)}
              onView={(view) => void db.showView(id, view)}
              focusRef={(f) => props.focusUi.setDbFocus(f)}
            />
          );
        }}
      </Show>
      <Show when={props.proxy.panel()}>
        {(panel) => (
          <ProxyPanel
            panel={panel()}
            machine={props.labelOf(panel().scope.target)}
            onSelect={props.proxy.select}
            onStep={props.proxy.step}
            onSide={props.proxy.toggleSide}
            onBack={() => focusTerminal()}
            onClose={() => props.proxy.closePanel()}
            onHelp={() => openKeyList("proxy")}
            mac={IS_MAC}
            onEdit={() => void props.proxy.startEdit()}
            onDraft={props.proxy.editDraft}
            onSend={() => void props.proxy.sendEdit()}
            onCancelEdit={props.proxy.cancelEdit}
            onHold={() => void props.proxy.toggleHold()}
            onRelease={(action) => void props.proxy.releaseHeld(action)}
            focusRef={(f) => props.focusUi.setProxyFocus(f)}
          />
        )}
      </Show>
      <Show when={props.empty}>
        <EmptyWorkspace
          leader={leaderKeyName(IS_MAC)}
          browser={props.browser}
          focusRef={(f) => props.focusUi.setEmptyFocus(f)}
        />
      </Show>
    </div>
  );
}
