// 内蔵ブラウザのタブ（#202）の、並びと、どれを出しているか。DOM も Tauri も使わない（node --test で確かめられる）。
//
// タブは GUI のワークスペース（features/workspaces/model.ts）に属する。ワークスペースの中の並びは、ターミナルのタブと混ぜて features/workspaces/model.ts が持つ。
// ここは、タブの中身（URL・題・表示の大きさ）と、ワークスペースごとに出しているタブ（views）を持つ。
// タブを選ぶと、グリッドの画面すべてがそのページになり、ターミナルのタブを選ぶと、ターミナルのグリッドになる。
// タブは、開いたときのターミナルのタブのマシン（target）とワークスペース（workspace）を覚える（リモートの localhost の中継で使う。#203。
// 持ち主のワークスペースが分からなくなったタブを、そのターミナルのタブのワークスペースに入れるのにも使う）。
// 開いていたタブ（ワークスペースと URL）は、殻がデータのフォルダに覚える（browser.rs の StoredTabs と同じ形。畳んだ印は GUI のワークスペースが覚えるので、
// collapsed は空で書く）。どれを出していたか（views）は覚えない（起動したときは、どのワークスペースもターミナルから始める）。
// シークレットのタブ（#204）は覚えない（閉じるとログインが消え、再起動しても戻さない）。

import { T } from "../../i18n/index.ts";
import type { WorkspaceId } from "../../infrastructure/rpc/protocol.ts";
import { SCALES } from "../scale/scale.ts";
import { isNewTab } from "./newTab.ts";

/** タブ 1 つ。 */
export interface BrowserTab {
  /** 子の webview のラベルになる id（英数字・- ・_ で 32 字まで） */
  id: string;
  /** 開いたときのターミナルのタブのマシン（ssh の行き先か `@local`） */
  target: string;
  /** 開いたときのターミナルのタブ（マシンの kisui serve のワークスペース） */
  workspace: WorkspaceId;
  /** 今出しているページの URL（開いた URL から、ページの遷移で変わる）。空は、まだ何も開いていない新しいタブのページ（#238。newTab.ts） */
  url: string;
  /** ページの題（まだ分からなければ空） */
  title: string;
  /**
   * シークレットのタブ（#204）。タブだけの、ディスクに残さないデータを使い、閉じるとログインが消える。覚えない（再起動しても戻さない）。
   * ページが開いた新しい窓のタブは、開いた元のタブと同じデータを使うので、元がシークレットならシークレット
   */
  incognito?: boolean;
  /** ページが開いた新しい窓のタブ（#204）の、開いた元のタブ。ページが自分を閉じたら、ここへ戻る。覚えない */
  opener?: string;
  /** 殻がもう webview を作ってある（ページが開いた新しい窓。#204）。画面は作らずに、そのまま使う。覚えない */
  made?: boolean;
  /**
   * ページの表示の大きさ（#205。1 が元の大きさ。無ければ 1）。タブごとに持ち、ページを移っても変わらない。覚える（再起動しても戻す）
   */
  zoom?: number;
  /**
   * ページの favicon（#237。殻が読んだ 32×32 の PNG の data: URL）。無ければ・読み込み中は無し（サイドバーは地球のアイコンを出す）。
   * 覚えない（シークレットのタブの favicon をディスクに残さないため。どのタブも、ページを読み込めばまた取れる）
   */
  favicon?: string;
}

/** タブ全部と、ワークスペースごとの表示。 */
export interface TabsState {
  /** 開いた順 */
  tabs: readonly BrowserTab[];
  /**
   * ワークスペースの id（features/workspaces/model.ts）→ 出しているページのタブの id。無ければターミナルのタブを出している。
   * ページのタブは、ブラウザのタブか DB のタブ（#347。id は "db" で始まり、ブラウザのタブの id と重ならない）。DB のタブを出すときは showView で書く
   */
  views: Readonly<Record<string, string>>;
}

/** 殻が覚える形（browser.rs の StoredTabs）。 */
export interface StoredTabs {
  tabs: {
    id: string;
    target: string;
    workspace: string;
    url: string;
    title: string;
    /** 表示の大きさ（百分率。元の大きさなら書かない） */
    zoom?: number;
  }[];
  /** 使わない（畳んだ印は GUI のワークスペースが覚える）。いつも空 */
  collapsed: { target: string; workspace: string }[];
}

/** タブが 1 つも無い、初めの状態。 */
export const EMPTY_TABS: TabsState = { tabs: [], views: {} };

/** ワークスペース gws で出しているタブ。ターミナルのタブを出していれば undefined。 */
export function shownTab(s: TabsState, gws: string): BrowserTab | undefined {
  const id = s.views[gws];
  return id === undefined ? undefined : s.tabs.find((t) => t.id === id);
}

/** ワークスペースで出すものを替える（null はターミナルのタブ）。 */
export function showTab(
  s: TabsState,
  gws: string,
  id: string | null,
): TabsState {
  if (id !== null && !s.tabs.some((t) => t.id === id)) return s;
  return showView(s, gws, id);
}

/**
 * ワークスペースで出すものを、ページのタブ id に替える（null はターミナルのタブ）。id がブラウザのタブかは確かめない
 * （DB のタブ（#347）を出すときに使う。そのタブがあるかは、呼ぶ側が確かめる）。
 */
export function showView(
  s: TabsState,
  gws: string,
  id: string | null,
): TabsState {
  const views = { ...s.views };
  if (id === null) {
    if (!(gws in views)) return s;
    delete views[gws];
  } else {
    if (views[gws] === id) return s;
    views[gws] = id;
  }
  return { ...s, views };
}

/**
 * タブを、ワークスペース from から to へ移したときの、表示（views）の書き換え（#308。所属と並びは features/workspaces/model.ts の moveTabTo）。
 * tab は移したブラウザのタブの id。ターミナルのタブを移したときは null。
 * - from がそのブラウザのタブを出していたなら、出すのをやめる（from は、ターミナルのタブを出す。無ければ、残りの最初のブラウザのタブ）。
 * - show なら、to で移したタブを出す（ターミナルのタブなら、to が覚えているブラウザのタブを外す）。
 * - show でなければ、to が出しているものを変えない。destShown は、移す前に to が出していたブラウザのタブ（覚えずに出していたものも。
 *   ターミナルのタブを出していれば undefined）。それを覚えさせる。覚えさせないと、ブラウザのタブだけのワークスペースは
 *   「最初のブラウザのタブ」か、入ってきたターミナルのタブを出すので、先頭に入れたタブ・移したターミナルのタブに替わってしまう。
 * タブの中身（URL・開いたときのマシンとワークスペース）は変えない（リモートの localhost の中継元は、開いたときのマシンのまま）。
 * DB のタブ（#347）も、tab にその id を渡せば同じに動く（tab と destShown は、記録にあるページのタブだと呼ぶ側が確かめたもの）。
 */
export function moveView(
  s: TabsState,
  p: {
    tab: string | null;
    from: string;
    to: string;
    show: boolean;
    destShown?: string;
  },
): TabsState {
  const left =
    p.tab !== null && s.views[p.from] === p.tab ? showView(s, p.from, null) : s;
  if (p.show) return showView(left, p.to, p.tab);
  return p.destShown === undefined ? left : showView(left, p.to, p.destShown);
}

/** ページのタブ id を出しているワークスペースを、ターミナルのタブに戻す（DB のタブを閉じたとき。#347）。 */
export function dropView(s: TabsState, id: string): TabsState {
  if (!Object.values(s.views).includes(id)) return s;
  return {
    ...s,
    views: Object.fromEntries(
      Object.entries(s.views).filter(([, v]) => v !== id),
    ),
  };
}

/** タブを足し、ワークスペース gws でそれを出す（gws が分からなければ、足すだけ）。 */
export function addTab(s: TabsState, tab: BrowserTab, gws?: string): TabsState {
  const next = { ...s, tabs: [...s.tabs, tab] };
  return gws === undefined ? next : showTab(next, gws, tab.id);
}

/**
 * タブを閉じる。出していたワークスペースは、ターミナルのタブに戻る（次に何を出すかは、閉じる前に呼ぶ側が決めて showTab で替える。
 * ふつうのブラウザで今のタブを閉じたときと同じに、同じワークスペースの次のタブを出す。features/workspaces/model.ts の after）。
 */
export function closeTab(s: TabsState, id: string): TabsState {
  if (!s.tabs.some((t) => t.id === id)) return s;
  return { ...dropView(s, id), tabs: s.tabs.filter((t) => t.id !== id) };
}

/** タブの URL・題・表示の大きさ・favicon を書き換える（ページが変わった）。同じなら s をそのまま返す。 */
export function updateTab(
  s: TabsState,
  id: string,
  patch: { url?: string; title?: string; zoom?: number; favicon?: string },
): TabsState {
  const i = s.tabs.findIndex((t) => t.id === id);
  if (i < 0) return s;
  const t = s.tabs[i];
  const next = { ...t, ...patch };
  if (
    next.url === t.url &&
    next.title === t.title &&
    next.zoom === t.zoom &&
    next.favicon === t.favicon
  )
    return s;
  const tabs = [...s.tabs];
  tabs[i] = next;
  return { ...s, tabs };
}

/** 画面に出すタブの名前。つけた名前（name。features/workspaces/model.ts の BrowserRef が持つ）、無ければページの題、それも無ければ host（新しいタブのページ（URL が空。#238）は「新しいタブ」）。 */
export function tabTitle(
  t: Pick<BrowserTab, "title" | "url">,
  name = "",
): string {
  return name || t.title || (isNewTab(t) ? T("newTab.name") : hostOf(t.url));
}

/** URL の host（題がまだ分からないタブの名前と、題の横に小さく出す）。読めなければ URL のまま。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** 殻に覚えさせる形。 */
export function toStored(s: TabsState): StoredTabs {
  return {
    tabs: s.tabs
      .filter((t) => !t.incognito)
      .map(({ id, target, workspace, url, title, zoom }) => ({
        id,
        target,
        workspace,
        url,
        title,
        ...(zoom !== undefined && zoom !== 1
          ? { zoom: Math.round(zoom * 100) }
          : {}),
      })),
    collapsed: [],
  };
}

/** 殻が覚えていたもの。形の違うもの・重なりは捨てる。どれもターミナルのタブから始める。 */
export function fromStored(v: unknown): TabsState {
  if (typeof v !== "object" || v === null) return EMPTY_TABS;
  const o = v as Partial<StoredTabs>;
  const tabs: BrowserTab[] = [];
  for (const t of Array.isArray(o.tabs) ? o.tabs : []) {
    if (
      typeof t === "object" &&
      t !== null &&
      typeof t.id === "string" &&
      validTabId(t.id) &&
      typeof t.target === "string" &&
      typeof t.workspace === "string" &&
      typeof t.url === "string" &&
      !tabs.some((x) => x.id === t.id)
    )
      tabs.push({
        id: t.id,
        target: t.target,
        workspace: t.workspace,
        url: t.url,
        title: typeof t.title === "string" ? t.title : "",
        ...zoomOf(t.zoom),
      });
  }
  return { tabs, views: {} };
}

/** 子の webview のラベルに使える id か（browser.rs の valid_tab と同じ）。 */
export function validTabId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(id);
}

/** 新しいタブの id。 */
export function newTabId(random: () => number = Math.random): string {
  let s = "t";
  for (let i = 0; i < 12; i++) s += Math.floor(random() * 36).toString(36);
  return s;
}

/** `://` 付きの scheme で始まる（normalizeUrl と urlOrSearch が同じ判断をする）。 */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `javascript:` などの、// の無い scheme（`localhost:3000` のようにポートが続くものは除く）。 */
const BARE_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
/** scheme の無い入力が、localhost・127.0.0.1・[::1] で始まるか（http で開く）。 */
const isLocalHost = (s: string) =>
  /^(localhost|127\.0\.0\.1|\[::1\])(?=$|[:/?#])/i.test(s);

/**
 * URL の入力欄に打ったものを、開く URL にする。開けないもの（http と https 以外・host が無い・ユーザー名とパスワード入り・
 * 空白や制御文字を含む）は null。scheme を省くと https（localhost・127.0.0.1・[::1] は http）にする。
 */
export function normalizeUrl(input: string): string | null {
  const s = input.trim();
  if (s === "" || s.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(s))
    return null;
  let full = s;
  if (!HAS_SCHEME.test(s)) {
    if (BARE_SCHEME.test(s)) return null; // javascript: などの、// の無い scheme
    const local = isLocalHost(s);
    full = `${local ? "http" : "https"}://${s}`;
  }
  try {
    const u = new URL(full);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** URL バーで検索語を Google で探すときの URL の前の部分（#232。検索エンジンは選べない）。 */
export const SEARCH_URL = "https://www.google.com/search?q=";
/** 検索語の長さの上限（これを超えた分は切り捨てる）。 */
const MAX_QUERY = 2048;

/**
 * URL バー（#232）に打ったものを、開く URL にする。URL なら normalizeUrl と同じに直し、URL でなければ Google の検索の URL にする。
 * 開けないもの（http と https 以外の scheme が明らかなもの・ユーザー名とパスワード入りなど）と空は null。
 * scheme を省いたものは、host に「.」がある（`example.com`）か、localhost・127.0.0.1・[::1] のときだけ URL と見なす。
 * 空白を含むもの・「.」の無い一語（`foo`）・`.` で終わるものなどは検索語にする。
 */
export function urlOrSearch(input: string): string | null {
  const s = input.trim();
  if (s === "") return null;
  // scheme が付いている（`://`）ものは、URL として開けるか開けないかだけ
  if (HAS_SCHEME.test(s)) return normalizeUrl(s);
  const oneWord = !/\s/.test(s);
  if (oneWord && looksLikeHost(s)) {
    const u = normalizeUrl(s);
    if (u !== null) return u;
  }
  // `javascript:` などの、// の無い scheme は検索語にしない（開けないものとして断る）
  if (oneWord && BARE_SCHEME.test(s)) return null;
  // 長すぎる検索語は切り詰めて探す（URL ではないので、URL の長さの上限で断らない）
  return SEARCH_URL + encodeURIComponent(s.slice(0, MAX_QUERY));
}

/** scheme の無い入力の host の部分が、URL らしいか（localhost 系か、「.」で区切った名前）。 */
function looksLikeHost(s: string): boolean {
  if (isLocalHost(s)) return true;
  const host = /^[^/?#]*/.exec(s)?.[0] ?? "";
  if (host.includes("@")) return false;
  const name = host.replace(/:\d*$/, "");
  if (!/^[^.\s:]+(\.[^.\s:]+)+$/.test(name)) return false;
  // 最後の「.」の後ろが、英字 2 字以上（com・dev・日本など）か xn-- で始まる名前か、IPv4 の 4 つ組のときだけ（`1.5` は検索）
  const last = name.slice(name.lastIndexOf(".") + 1);
  return (
    /^(\p{L}{2,}|xn--[a-z0-9-]+)$/iu.test(last) ||
    /^(\d{1,3}\.){3}\d{1,3}$/.test(name)
  );
}

/** 覚えていた表示の大きさ（百分率）を、タブの zoom にする。選べる大きさ（scale.ts の SCALES）でなければ元の大きさ。 */
function zoomOf(percent: unknown): { zoom?: number } {
  if (typeof percent !== "number") return {};
  const z = percent / 100;
  return SCALES.includes(z) && z !== 1 ? { zoom: z } : {};
}
