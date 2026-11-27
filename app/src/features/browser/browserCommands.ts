// `kisui browser`（#515）：Pane の中のコマンドが Window に頼む、Browser tab の操作（new・url・back・forward・reload・stop・close・rename・
// external・copy-url・bookmark・find・devtools・login）。commands/windowRun.ts の受け持ちの表を作る。行うことは、キー操作の Command
// （browser.*）と同じ（ページへの操作は、ブラウザのタブの Dialog と同じ whyNot の決まりで、今できないときは理由で断る）で、違いは、
// 相手の Tab を引数（id か名前）で指すことと、Dialog も Toast も出さないことと、結果を返すこと。画面にも Tauri にも触らない。
// ページの中身を読む・ページを操作する頼みは作らない。
//
// 届く範囲：Browser tab は手元の PC の Tab として扱う（`kisui tab` と同じ。sessions/machines.ts の windowReachAllowed）。
//   - 手元の PC の Pane からは、いつでも届く。
//   - リモートの Machine の Pane からは、Window の前の人が時間を決めて許している間（paneGrant.ts。Machine の Dialog の `p`）だけ届く。
//     許していなければ、一覧にも出さず、指されたら「無い」ときと同じ文で断る。ブックマークの一覧と `new` も、同じ許しが要る。
//   - URL を開く頼み（new に URL を付けた・url・external）と、人が続きを行う画面を開く頼み（devtools・login）は、許している間でも、
//     手元の PC に「操作のたびに聞く」と決めた Pane があるうちは、リモートの Machine には通さない（人が聞くと決めたことを、
//     リモートの Machine が聞かずに済ませない。`kisui tab close` と同じ）。
//   - どれも人のキーの行き先は、手元の PC の Tab（Browser tab）へしか変わらない。リモートの Machine の Pane は許している間しか届かず、
//     その間は、その Machine はもう手元の PC の Pane にキーを送れるので、キーの行き先の確認（keysMayMove）は要らない。
// 内蔵ブラウザを使わない設定のときは、どれも理由を出して断る。
import { untrack, type Accessor } from "solid-js";

import { T } from "../../i18n/index.ts";
import {
  argFlag,
  argOptionalString,
  argString,
  WindowCommandError,
  type WindowCaller,
  type WindowCommand,
  type WindowCommandTable,
} from "../commands/windowRun.ts";
import type { Sessions } from "../sessions/controller.ts";
import { windowReachAllowed } from "../sessions/machines.ts";
import { LOCAL } from "../sessions/shell.ts";
import { isOpenableUrl, type OpenUrlExternally } from "../terminal/urlOpen.ts";
import {
  gwsOfTerm,
  nameErrorText,
  refKey,
  type GwsState,
} from "../workspaces/model.ts";
import type { Row } from "../workspaces/rows.ts";
import type { Tabs } from "../workspaces/tabs/controller.ts";
import {
  findTabs,
  tabEntries,
  type TabEntry,
} from "../workspaces/tabs/tabCommands.ts";
import type { Bookmarks } from "./bookmarksStore.ts";
import type { BrowserOs } from "./os.ts";
import type { Pages } from "./pages.ts";
import type { BrowserTab } from "./tabs.ts";
import type { BrowserTabs } from "./tabsStore.ts";
import { whyNot, type BrowserOp } from "./window.ts";

/** `kisui browser bookmark list --json` の 1 つ（cmd/kisui/browser.go の bookmarkInfo と同じ形）。 */
export interface BookmarkInfo {
  url: string;
  title: string;
}

/** 開いてよい URL の長さの上限（バイト。server/media.go の maxOpenURL と同じ）。 */
const MAX_URL = 4096;

/**
 * 引数の URL を確かめて、整えた形を返す。http か https の、ホストのある URL だけ（ユーザー名とパスワードを含まない。制御文字を含まない。
 * serve の `kisui open` が通す URL と同じ）。ほかは断る。
 */
export function checkUrl(raw: string): string {
  const s = raw.trim();
  if (
    s === "" ||
    new TextEncoder().encode(s).length > MAX_URL ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f]/.test(s) ||
    !isOpenableUrl(s)
  )
    throw new WindowCommandError(T("browserCli.err.url", { url: s }));
  const u = new URL(s);
  if (u.username !== "" || u.password !== "")
    throw new WindowCommandError(T("browserCli.err.url", { url: s }));
  return u.href;
}

/** `kisui browser` の受け持ちの表を作る。 */
export function createBrowserCommands(deps: {
  sessions: Pick<Sessions, "machines" | "labelOf">;
  gws: Accessor<GwsState>;
  /** Sidebar の行（workspaces/controller.ts の rows） */
  rows: Accessor<readonly Row[]>;
  /** 内蔵ブラウザを使うか（使わなければ、どれも断る） */
  browser: boolean;
  browserTabs: Pick<BrowserTabs, "tabs">;
  tabs: Pick<
    Tabs,
    "closeTabRow" | "setTabName" | "newBrowserTab" | "newBrowserTabAt"
  >;
  pages: Pick<Pages, "navPage" | "stopPage" | "goToChecked">;
  bookmarks: Pick<Bookmarks, "bookmarkPageChecked" | "readBookmarks">;
  os: Pick<BrowserOs, "findInTab" | "openTabDevtools" | "startPasskeyLogin">;
  /** URL を手元の外部ブラウザで開く */
  openUrlExternally: OpenUrlExternally;
  /** Machine from に、手元の PC の Pane の操作を、今、時間を決めて許しているか（paneGrant.ts） */
  granted(from: string): boolean;
  /** 手元の PC に、操作のたびに人に聞くと決めた Pane が 1 つでもあるか（paneApproval.ts） */
  anyAskEach(): boolean;
}): WindowCommandTable {
  const { machines, labelOf } = deps.sessions;

  /** 内蔵ブラウザを使っていなければ断る。 */
  function needEnabled() {
    if (!deps.browser)
      throw new WindowCommandError(T("browserCli.err.disabled"));
  }

  /** Machine from の Pane が、手元の PC の Browser tab に届かなければ断る。 */
  function needReach(c: WindowCaller) {
    if (
      !windowReachAllowed(
        untrack(machines),
        c.from,
        LOCAL,
        deps.granted(c.from),
      )
    )
      throw new WindowCommandError(
        T("browserCli.err.reach", { from: labelOf(c.from) }),
      );
  }

  /**
   * URL を開く頼みと、人が続きを行う画面を開く頼みを、リモートの Machine の Pane から通してよいか確かめる。
   * 手元の PC に「操作のたびに聞く」と決めた Pane があるうちは、リモートの Machine には通さない。
   */
  function needNoAskEach(c: WindowCaller) {
    if (c.from !== LOCAL && deps.anyAskEach())
      throw new WindowCommandError(T("browserCli.err.askEach"));
  }

  /** Machine from の Pane から届く Tab（Sidebar の並びの順）。 */
  function reachable(from: string): TabEntry[] {
    const list = untrack(machines);
    const granted = deps.granted(from);
    return tabEntries(untrack(deps.gws), untrack(deps.rows)).filter((e) =>
      windowReachAllowed(list, from, e.target, granted),
    );
  }

  /** 引数 tab が指す、届く Browser tab 1 つ。無い・届かない・2 つ以上に当たる・Browser tab でないときは断る。 */
  function resolve(
    args: Record<string, unknown>,
    c: WindowCaller,
  ): { e: TabEntry; t: BrowserTab } {
    needEnabled();
    const tab = argString(args, "tab").trim();
    const found = findTabs(reachable(c.from), tab);
    if (found.length > 1)
      throw new WindowCommandError(
        T("tabCli.err.ambiguous", {
          tab,
          count: found.length,
          ids: found.map((e) => e.id).join(", "),
        }),
      );
    if (found.length === 0)
      throw new WindowCommandError(
        c.from === LOCAL
          ? T("tabCli.err.noTab", { tab })
          : T("tabCli.err.noTabReach", { tab, from: labelOf(c.from) }),
      );
    const e = found[0];
    if (e.ref.kind !== "browser")
      throw new WindowCommandError(T("browserCli.err.notBrowser", { tab }));
    const t = untrack(deps.browserTabs.tabs).tabs.find((x) => x.id === e.id);
    if (!t) throw new WindowCommandError(T("tabCli.err.noTab", { tab }));
    return { e, t };
  }

  /**
   * ページへの操作 op の受け持ち。act が行い、返した値が結果になる（無ければ { id }）。
   * 今できない操作は、ブラウザのタブの Dialog が行に出す理由と同じ理由で断る。opens が true の操作は、needNoAskEach の確かめも掛ける。
   */
  function pageCommand(
    op: BrowserOp,
    opens: boolean,
    act: (
      t: BrowserTab,
      args: Record<string, unknown>,
    ) => unknown | Promise<unknown>,
  ): WindowCommand {
    return {
      remote: true,
      run: async (args, c) => {
        const { e, t } = resolve(args, c);
        if (opens) needNoAskEach(c);
        const why = whyNot(t, op);
        if (why) throw new WindowCommandError(why);
        return (await act(t, args)) ?? { id: e.id };
      },
    };
  }

  /** `kisui browser login` が断られた理由（殻の答え）。 */
  const loginWhy = (
    r: "incognito" | "no-sites" | "not-allowed",
    url: string,
  ): string => {
    if (r === "incognito") return T("cannot.browser.login.incognito");
    if (r === "no-sites") return T("cannot.browser.login.noSites");
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      // URL の形でなければそのまま出す
    }
    return T("cannot.browser.login.notAllowed", { host });
  };

  return {
    "browser.new": {
      remote: true,
      run: async (args, c) => {
        needEnabled();
        needReach(c);
        const raw = argOptionalString(args, "url");
        const priv = argFlag(args, "private");
        // 作るのは、頼んだ Pane の Terminal tab がある Workspace（キー操作の browser.new は今いる Workspace）
        const g = gwsOfTerm(untrack(deps.gws), c.from, c.tab);
        if (!g) throw new WindowCommandError(T("browserCli.err.noWorkspace"));
        if (raw === undefined) return { id: deps.tabs.newBrowserTab(g, priv) };
        const url = checkUrl(raw);
        needNoAskEach(c);
        return { id: await deps.tabs.newBrowserTabAt(g, url, priv) };
      },
    },

    "browser.url": pageCommand("url", true, async (t, args) => {
      const url = checkUrl(argString(args, "url"));
      await deps.pages.goToChecked(t.id, url);
      return undefined;
    }),

    "browser.back": pageCommand("back", false, (t) => {
      deps.pages.navPage(t.id, "back");
      return undefined;
    }),
    "browser.forward": pageCommand("forward", false, (t) => {
      deps.pages.navPage(t.id, "forward");
      return undefined;
    }),
    "browser.reload": pageCommand("reload", false, (t) => {
      deps.pages.navPage(t.id, "reload");
      return undefined;
    }),
    "browser.stop": pageCommand("stop", false, (t) => {
      deps.pages.stopPage(t.id);
      return undefined;
    }),

    "browser.close": {
      remote: true,
      run: (args, c) => {
        const { e } = resolve(args, c);
        deps.tabs.closeTabRow(e.gws.id, refKey(e.ref));
        return { id: e.id };
      },
    },

    "browser.rename": {
      remote: true,
      run: async (args, c) => {
        const { e } = resolve(args, c);
        const name = argString(args, "name");
        const bad = nameErrorText(name);
        if (bad) throw new WindowCommandError(bad);
        await deps.tabs.setTabName(e.gws.id, refKey(e.ref), name);
        return { id: e.id };
      },
    },

    "browser.external": pageCommand("external", true, async (t) => {
      if (!isOpenableUrl(t.url))
        throw new WindowCommandError(T("browserCli.err.url", { url: t.url }));
      await deps.openUrlExternally(t.target, t.url);
      return undefined;
    }),

    // クリップボードには書かない（URL を結果として返す）
    "browser.copyUrl": pageCommand("copyUrl", false, (t) => ({
      id: t.id,
      url: t.url,
    })),

    "browser.bookmark": pageCommand("bookmark", false, async (t) => {
      await deps.bookmarks.bookmarkPageChecked(t);
      return undefined;
    }),

    "browser.bookmarks": {
      remote: true,
      run: async (_args, c): Promise<{ bookmarks: BookmarkInfo[] }> => {
        needEnabled();
        needReach(c);
        const list = await deps.bookmarks
          .readBookmarks()
          .catch((e: unknown) => {
            throw new WindowCommandError(
              e instanceof Error ? e.message : String(e),
            );
          });
        // Chrome のブックマークは、読むだけの別のもので、一覧に含めない
        return { bookmarks: list.map((b) => ({ url: b.url, title: b.title })) };
      },
    },

    "browser.find": pageCommand("find", false, async (t, args) => {
      const text = argString(args, "text");
      if (text === "")
        throw new WindowCommandError(T("windowRun.err.arg", { name: "text" }));
      return {
        id: t.id,
        found: await deps.os.findInTab(t.id, text, "first"),
      };
    }),

    "browser.devtools": pageCommand("devtools", true, async (t) => {
      await deps.os.openTabDevtools(t.id);
      return undefined;
    }),

    "browser.login": pageCommand("login", true, async (t) => {
      const r = await deps.os.startPasskeyLogin(t.id);
      if (r !== "opened") throw new WindowCommandError(loginWhy(r, t.url));
      return undefined;
    }),
  };
}
