// 右のペイン。フォーカスしているワークスペースのターミナル（先頭がプライマリ）を、kisui serve が持つ分割の木の通りに並べる（terminal/）。
// 内蔵ブラウザのタブを出していれば、その場所すべてがそのページになる（browser/。URL バー・新しいタブのページ・ページ内検索もここに重ねる）。
import { Show, type JSX } from "solid-js";

import type { Bookmarks } from "../../../features/browser/bookmarksStore.ts";
import type { Pages } from "../../../features/browser/pages.ts";
import type { BrowserTabs } from "../../../features/browser/tabsStore.ts";
import { interceptKeys } from "../../../features/commands/commands.ts";
import { IS_MAC } from "../../../features/commands/guiKeys.ts";
import type { ReportProblem } from "../../../features/problem.ts";
import type { Terminals } from "../../../features/terminal/controller.ts";
import type { FocusUi } from "../focus.ts";
import { usePorts } from "../../ports.ts";
// CSS を持つ部品の import は、この順（ブラウザ → リーダーの案内 → ターミナル）を変えない（理由は page.tsx）
import { BrowserArea } from "./browser/BrowserArea.tsx";
import { FindBar } from "./browser/FindBar.tsx";
import { NewTabPage } from "./browser/NewTabPage.tsx";
import { UrlBar } from "./browser/UrlBar.tsx";
import { leaderPath } from "../commands/LeaderMenu.tsx";
import { TerminalGrid } from "./terminal/TerminalGrid.tsx";

export function ContentArea(props: {
  /** ペインの要素を受け取る */
  ref: (el: HTMLDivElement) => void;
  /** 内蔵ブラウザのタブを使うか（設定の [gui.browser] enabled。#202） */
  browser: boolean;
  terminals: Terminals;
  browserTabs: BrowserTabs;
  pages: Pages;
  bookmarks: Bookmarks;
  focusUi: FocusUi;
  /** リサイズモードで選んでいる、ペインどうしの境界 */
  litSplit: string | undefined;
  /** フォーカスしているワークスペースのマシンの色 */
  accent: string | undefined;
  /** 画面全体の大きさ（webview の zoom） */
  scale: () => number;
  setFocusError: ReportProblem;
}): JSX.Element {
  const { navTab } = usePorts().browser;
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
    closeFind,
    openUrl,
  } = props.pages;
  const { bookmarks, chromeBookmarks } = props.bookmarks;
  const { focusTerminal } = props.focusUi;
  return (
    <div class="main" ref={props.ref}>
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
                  void navTab(id, action).catch(() => {});
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
                chrome={chromeBookmarks()}
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
    </div>
  );
}
