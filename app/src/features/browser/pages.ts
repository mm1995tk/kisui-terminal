// 内蔵ブラウザのタブ（#202。設定の [gui.browser] enabled で有効にしたときだけ）の、ページの操作。
// タブは GUI のワークスペースに属し、サイドバーのワークスペースの帯の下に、ターミナルのタブと一緒に並ぶ（#231）。タブを選ぶと、グリッドの場所すべてがそのページになる。
// 今出しているタブ、URL を開く（新しいタブ・URL バー）、リモートの localhost の中継、ページが開いた・閉じた窓、ページ内検索、ページの表示の大きさを受け持つ。
// タブの追加・削除・並び順・選択は features/workspaces/tabs/controller.ts。
// 画面にも Tauri にも触らない。殻への頼みは BrowserOs（os.ts）で受け取る。
import { T } from "../../i18n/index.ts";
import type { UrlClick } from "coneko-term";
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";

import type { WorkspaceId } from "../../infrastructure/rpc/protocol.ts";
import type { ReportProblem } from "../problem.ts";
import { nextScale, type ScaleAction } from "../scale/scale.ts";
import {
  isOpenableUrl,
  urlClickAction,
  type OpenUrlExternally,
} from "../terminal/urlOpen.ts";
import type { Workspaces } from "../workspaces/controller.ts";
import {
  addBrowser,
  gwsOfBrowser,
  gwsOfTerm,
  shownBrowserId,
} from "../workspaces/model.ts";
import { isNewTab, NEW_TAB_URL } from "./newTab.ts";
import type { BrowserOs, TabPopup } from "./os.ts";
import { addRelayed, relayedOf, unrelay, type Relayed } from "./relay.ts";
import { addTab, newTabId, updateTab, type BrowserTab } from "./tabs.ts";
import type { BrowserTabs } from "./tabsStore.ts";

export type Pages = ReturnType<typeof createPages>;

export function createPages(deps: {
  os: BrowserOs;
  /** 内蔵ブラウザのタブを使うか（設定の [gui.browser] enabled） */
  browser: boolean;
  /** macOS か（URL のクリックの修飾キーを決める） */
  mac: boolean;
  browserTabs: BrowserTabs;
  workspaces: Workspaces;
  /** URL を手元の外部ブラウザで開く */
  openUrlExternally: OpenUrlExternally;
  /** ブラウザのタブを閉じる（出すタブの移り先も決める。features/workspaces/tabs/controller.ts の removeTab） */
  removeTab: (id: string, back?: string) => void;
  setFocusError: ReportProblem;
  /** 今使っているペイン（ブラウザのタブを出していればそのページ）にキーを向ける */
  focusTerminal: () => void;
  /** ページから押したときに覚えた「キーを戻す先」を捨てる */
  forgetPageReturn: () => void;
  /** ページ内検索の欄の入力欄にキーを向ける */
  focusFind: () => void;
  /** 変えた大きさを少しの間見せる */
  showScale: (v: number) => void;
}) {
  const { setFocusError, focusTerminal, removeTab } = deps;
  const {
    resolveTabUrl,
    closeTabView,
    goTab,
    zoomTab,
    onTabPage,
    onTabTitle,
    onTabFavicon,
    onTabPopup,
    onTabClosed,
  } = deps.os;
  const { tabs, setTabs } = deps.browserTabs;
  const { focus, gws, setGws, currentGws, cannot } = deps.workspaces;
  /** 今のワークスペースで出しているブラウザのタブ。ターミナルのタブを出していれば undefined。 */
  const shownBrowserTab = createMemo(() => {
    const g = currentGws();
    if (!deps.browser || !g) return undefined;
    const id = shownBrowserId(g, tabs().views[g.id], (x) =>
      tabs().tabs.some((t) => t.id === x),
    );
    return id === undefined ? undefined : tabs().tabs.find((t) => t.id === id);
  });
  /** 出しているタブのうち、ページを開いているもの（URL バーを出す）と、新しいタブのページ（#238。NewTabPage を出す）の id */
  const pageTabId = createMemo(() => {
    const t = shownBrowserTab();
    return t && !isNewTab(t) ? t.id : undefined;
  });
  const newTabPageId = createMemo(() => {
    const t = shownBrowserTab();
    return t && isNewTab(t) ? t.id : undefined;
  });
  /**
   * タブ → これまで使った中継の origin と元の origin（リモートのマシンの localhost 系を `kisui relay` の中継で開いたタブだけ。#203）。
   * タブは元の URL を覚えて入力欄に出し、ページから届く中継の URL は元の URL に戻してから書く（features/browser/relay.ts）。
   * 戻る・進むで前の中継の URL に戻ることもあるので、対応は足すだけにし、捨てるのはタブを閉じたときだけ
   */
  const relays = new Map<string, readonly Relayed[]>();
  /** タブ tab で url を開くときに、ページに実際に開かせる URL を得て、中継の対応を覚える。 */
  async function resolveFor(
    tab: Pick<BrowserTab, "id" | "target">,
    url: string,
  ): Promise<string> {
    const opened = await resolveTabUrl(tab.target, url);
    const r = relayedOf(url, opened);
    if (r) relays.set(tab.id, addRelayed(relays.get(tab.id) ?? [], r));
    return opened;
  }
  // 閉じたタブの対応を捨てる
  createEffect(() => {
    const alive = new Set(tabs().tabs.map((t) => t.id));
    for (const id of [...relays.keys()]) if (!alive.has(id)) relays.delete(id);
  });
  /**
   * URL をワークスペースの新しいタブで開く（`kisui open`・shj の URL を開く要求・ターミナルの URL のクリック。#203）。
   * リモートのマシンの localhost 系は、先に中継を用意する（そのポートで誰も待っていなければ、タブを作らずにそう出す。外部ブラウザと同じ）。
   * フォーカスしているワークスペースなら、そのページにキーを向ける。ほかのワークスペースなら、そこへは移らない
   * （そのワークスペースに移ると、タブのページが出ている）。
   */
  function openInNewTab(target: string, ws: WorkspaceId, url: string) {
    const tab: BrowserTab = {
      id: newTabId(),
      target,
      workspace: ws,
      url,
      title: "",
    };
    resolveFor(tab, url).then(
      () => {
        // 持ち主は、そのターミナルのタブがあるワークスペース（無ければ、分かったときに reconcile が入れる）
        const gid = gwsOfTerm(untrack(gws), target, ws)?.id;
        setTabs((s) => addTab(s, tab, gid));
        if (gid) setGws((g) => addBrowser(g, gid, tab.id));
        const f = untrack(focus);
        if (gid && f && gwsOfTerm(untrack(gws), f.target, f.id)?.id === gid)
          focusTerminal();
      },
      (e: unknown) =>
        setFocusError({
          title: T("err.url.open"),
          error: e instanceof Error ? e.message : String(e),
        }),
    );
  }
  /**
   * 新しいタブのページのタブを開く（リーダーの o n・o N と、「+」のメニューの「ブラウザ」。#238）。URL は聞かず、URL が空のタブ（newTab.ts）を
   * 足して出す。検索窓とブックマークの中身は NewTabPage が描く（出たら検索窓にキーがある）。今のタブの URL の書き換えは、ページの上の URL バー（#232）
   */
  function openNewTab(
    target: string,
    ws: WorkspaceId,
    incognito: boolean,
    owner?: string,
  ) {
    const id = newTabId();
    const gid = owner ?? gwsOfTerm(untrack(gws), target, ws)?.id;
    // ページから押したときに覚えた「戻す先」を捨てる（検索窓にキーを向けるのを、ページに戻させない。openFind と同じ）
    deps.forgetPageReturn();
    setTabs((s) =>
      addTab(
        s,
        {
          id,
          target,
          workspace: ws,
          url: NEW_TAB_URL,
          title: "",
          ...(incognito ? { incognito: true } : {}),
        },
        gid,
      ),
    );
    if (gid) setGws((g) => addBrowser(g, gid, id));
  }
  /**
   * ページが新しい窓（`target=_blank` のリンク・`window.open`）を開いた（#204）。殻はもう webview を作ってある。
   * 開いた元のタブと同じワークスペースの新しいタブにして出す（元がシークレットならシークレット。データは元と同じ）。
   * 元のタブがもう無ければ、webview を壊す。
   */
  function addPopupTab(e: TabPopup) {
    const from = untrack(tabs).tabs.find((t) => t.id === e.opener);
    // 足す前にページが閉じていた（window.open(...).close()。殻の知らせは「閉じた」が先に届きうる）なら、足さずに壊す
    if (!from || closedEarly.delete(e.tab)) {
      void closeTabView(e.tab).catch(() => {});
      return;
    }
    // 中継で開いているタブから開いたなら、中継の対応を引き継ぐ（同じ origin のページを開くことが多い）
    const r = relays.get(from.id);
    if (r) relays.set(e.tab, r);
    const tab: BrowserTab = {
      id: e.tab,
      target: from.target,
      workspace: from.workspace,
      url: unrelay(e.url, r),
      title: "",
      incognito: from.incognito,
      opener: from.id,
      made: true,
    };
    const gid = gwsOfBrowser(untrack(gws), from.id)?.id;
    setTabs((s) => addTab(s, tab, gid));
    if (gid) setGws((g) => addBrowser(g, gid, tab.id));
    if (gid && untrack(currentGws)?.id === gid) focusTerminal();
  }
  /**
   * まだ足していないタブの「閉じた」（ページが開いた新しい窓が、画面に知らせが届く前に閉じた）。あとで届く「新しいタブ」を足さない。
   * 知らないタブの知らせが積もらないよう、新しい 32 個だけ覚える
   */
  const closedEarly = new Set<string>();
  /** ページが自分を閉じた（`window.close()`。#204）。タブを閉じ、出していたなら開いた元のタブに戻る。 */
  function closedByPage(id: string) {
    const tab = untrack(tabs).tabs.find((t) => t.id === id);
    if (!tab) {
      closedEarly.add(id);
      for (const old of closedEarly) {
        if (closedEarly.size <= 32) break;
        closedEarly.delete(old);
      }
      return;
    }
    const shown = untrack(shownBrowserTab)?.id === id;
    removeTab(id, tab.opener);
    if (shown) focusTerminal();
  }

  // ---- 内蔵ブラウザのページ内検索（#205）。出しているタブの下の端に、検索の欄を出す ----
  /** 検索の欄を出しているタブ。無ければ null */
  const [findTab, setFindTab] = createSignal<string | null>(null);
  /** 検索の欄を開く。開いていれば、入力欄にキーを向ける。 */
  function openFind(t: BrowserTab) {
    // ページから押したときに覚えた「戻す先」を捨てる。ページを押した後も画面のキーの行き先は入力欄のまま残るので、
    // 捨てないと「行き先が変わっていない」と見て、キーをページに戻してしまう
    deps.forgetPageReturn();
    if (untrack(findTab) === t.id) deps.focusFind();
    else setFindTab(t.id);
  }
  // ---- 内蔵ブラウザの URL バー（#232）。出しているタブのページの上の端 ----
  /** URL バーで決めた。今のタブで開く。 */
  function submitUrlBar(tab: string, url: string) {
    // 中継を用意できてから（リモートのマシンの localhost 系）タブの URL を書き換える。用意できなければ、ページも URL も前のまま。
    // まだ作っていない・開けなかったタブは、BrowserArea が書き換えた URL で作る（goTab は失敗する）
    const t = untrack(tabs).tabs.find((x) => x.id === tab);
    if (t)
      resolveFor(t, url).then(
        (opened) => {
          setTabs((s) => updateTab(s, tab, { url }));
          void goTab(tab, opened).catch(() => {});
        },
        (e: unknown) =>
          setFocusError({
            title: T("err.page.open"),
            error: e instanceof Error ? e.message : String(e),
          }),
      );
    focusTerminal();
  }

  /** 検索の欄を閉じ、キーをページに戻す。 */
  function closeFind() {
    setFindTab(null);
    focusTerminal();
  }
  // 出すタブが替わったら（グリッドに戻った・ほかのタブへ）、検索の欄を閉じる
  createEffect(
    on(shownBrowserTab, (t) => {
      const open = untrack(findTab);
      if (open !== null && t?.id !== open) setFindTab(null);
    }),
  );

  /** ブラウザを出している間の表示の大きさ（リーダーの v のグループ。#205）。ページの表示の大きさを変え、タブに覚える。 */
  function changePageZoom(t: BrowserTab, a: ScaleAction) {
    const z = nextScale(t.zoom ?? 1, a);
    setTabs((s) => updateTab(s, t.id, { zoom: z === 1 ? undefined : z }));
    void zoomTab(t.id, z).catch(() => {});
    deps.showScale(z);
  }

  /**
   * URL を開く。`ws` を渡し、内蔵ブラウザを有効にしていれば（#203）、そのワークスペースの新しいタブで開く。
   * そうでなければ手元の外部ブラウザで開く。どちらも、リモートのマシンの localhost 系は、殻が `kisui relay` の中継越しに開く（#96・#127）。
   */
  function openUrlFor(target: string, url: string, ws?: WorkspaceId) {
    if (!isOpenableUrl(url)) return;
    if (deps.browser && ws !== undefined) {
      openInNewTab(target, ws, url);
      return;
    }
    deps.openUrlExternally(target, url).catch((e: unknown) =>
      setFocusError({
        title: T("err.url.open"),
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }

  /**
   * ターミナルの URL がクリックされた（#47）。cmd（macOS 以外は ctrl）を押していなければ何もしない。
   * cmd + クリックは、内蔵ブラウザを有効にしていれば今のワークスペースの新しいタブ、無効なら手元の外部ブラウザで開く（#203）。
   * cmd + option + クリック（macOS 以外は ctrl + alt）は、いつも外部ブラウザで開く。shift は付けても同じ。
   * 開くのは http と https の URL だけ。
   */
  function openUrl(click: UrlClick) {
    const action = urlClickAction(click, deps.mac);
    if (!isOpenableUrl(click.url) || action === null) return;
    const f = focus();
    if (f)
      openUrlFor(f.target, click.url, action === "open" ? f.id : undefined);
  }

  if (deps.browser) {
    // await の後は Owner が無いので、onCleanup は先に登録する
    const offs: (() => void)[] = [];
    onCleanup(() => offs.forEach((f) => f()));
    onMount(async () => {
      // 閉じたワークスペースのタブは、reconcile が捨てる（読み終えたあと、一覧が分かっていれば）
      await deps.browserTabs.load();
      offs.push(
        await onTabPage((e) => {
          // 中継で開いているタブは、元の URL に戻して覚える（入力欄にも元の URL を出す）
          const url = unrelay(e.url, relays.get(e.tab));
          if (isOpenableUrl(url)) setTabs((t) => updateTab(t, e.tab, { url }));
          // 読み込み中は地球のアイコン（#237。読み込みが終われば、殻が新しいページの favicon を知らせる）
          if (e.loading)
            setTabs((t) => updateTab(t, e.tab, { favicon: undefined }));
        }),
        await onTabFavicon((e) =>
          setTabs((t) => updateTab(t, e.tab, { favicon: e.icon || undefined })),
        ),
        await onTabTitle((e) =>
          setTabs((t) => updateTab(t, e.tab, { title: e.title })),
        ),
        await onTabPopup(addPopupTab),
        await onTabClosed((e) => closedByPage(e.tab)),
      );
    });
  }

  /** 今のワークスペースで出しているタブ。無ければ「できない」と知らせて undefined。 */
  function currentTab() {
    const t = shownBrowserTab();
    if (!t)
      cannot(T("cannot.browser.noTab.title"), T("cannot.browser.noTab.text"));
    return t;
  }
  /** 今のタブ。ページを開いていない新しいタブのページ（#238）なら「できない」と知らせて undefined（足す・コピー・検索などページが要る操作用）。 */
  function currentPage() {
    const t = currentTab();
    if (t && isNewTab(t)) {
      cannot(T("cannot.browser.newTab.title"), T("cannot.browser.newTab.text"));
      return undefined;
    }
    return t;
  }

  return {
    shownBrowserTab,
    /** 出しているタブのうち、ページを開いているもの（URL バーを出す）の id */
    pageTabId,
    /** 出しているタブのうち、新しいタブのページ（#238）の id */
    newTabPageId,
    resolveFor,
    openInNewTab,
    openNewTab,
    /** 検索の欄を出しているタブ。無ければ null */
    findTab,
    openFind,
    closeFind,
    submitUrlBar,
    changePageZoom,
    openUrlFor,
    openUrl,
    currentTab,
    currentPage,
  };
}
