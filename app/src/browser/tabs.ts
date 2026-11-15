// 内蔵ブラウザのタブ（#202）の、並びと、どれを出しているか。DOM も Tauri も使わない（node --test で確かめられる）。
//
// タブは GUI のワークスペース（gws/model.ts）に属する。ワークスペースの中の並びは、ターミナルのタブと混ぜて gws/model.ts が持つ。
// ここは、タブの中身（URL・題・表示の大きさ）と、ワークスペースごとに出しているタブ（views）を持つ。
// タブを選ぶと、グリッドの画面すべてがそのページになり、ターミナルのタブを選ぶと、ターミナルのグリッドになる。
// タブは、開いたときのターミナルのタブのマシン（target）とワークスペース（workspace）を覚える（リモートの localhost の中継で使う。#203。
// 持ち主のワークスペースが分からなくなったタブを、そのターミナルのタブのワークスペースに入れるのにも使う）。
// 開いていたタブ（ワークスペースと URL）は、殻がデータのフォルダに覚える（browser.rs の StoredTabs と同じ形。畳んだ印は GUI のワークスペースが覚えるので、
// collapsed は空で書く）。どれを出していたか（views）は覚えない（起動したときは、どのワークスペースもターミナルから始める）。
// シークレットのタブ（#204）は覚えない（閉じるとログインが消え、再起動しても戻さない）。

import type { WorkspaceId } from "../rpc/protocol.ts";
import { SCALES } from "../scale.ts";

/** タブ 1 つ。 */
export interface BrowserTab {
  /** 子の webview のラベルになる id（英数字・- ・_ で 32 字まで） */
  id: string;
  /** 開いたときのターミナルのタブのマシン（ssh の行き先か `@local`） */
  target: string;
  /** 開いたときのターミナルのタブ（マシンの kisui serve のワークスペース） */
  workspace: WorkspaceId;
  /** 今出しているページの URL（開いた URL から、ページの遷移で変わる） */
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
}

/** タブ全部と、ワークスペースごとの表示。 */
export interface TabsState {
  /** 開いた順 */
  tabs: readonly BrowserTab[];
  /** ワークスペースの id（gws/model.ts）→ 出しているブラウザのタブの id。無ければターミナルのタブを出している */
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

/** タブを足し、ワークスペース gws でそれを出す（gws が分からなければ、足すだけ）。 */
export function addTab(s: TabsState, tab: BrowserTab, gws?: string): TabsState {
  const next = { ...s, tabs: [...s.tabs, tab] };
  return gws === undefined ? next : showTab(next, gws, tab.id);
}

/**
 * タブを閉じる。出していたワークスペースは、ターミナルのタブに戻る（次に何を出すかは、閉じる前に呼ぶ側が決めて showTab で替える。
 * ふつうのブラウザで今のタブを閉じたときと同じに、同じワークスペースの次のタブを出す。gws/model.ts の after）。
 */
export function closeTab(s: TabsState, id: string): TabsState {
  if (!s.tabs.some((t) => t.id === id)) return s;
  const views = Object.fromEntries(
    Object.entries(s.views).filter(([, v]) => v !== id),
  );
  return { tabs: s.tabs.filter((t) => t.id !== id), views };
}

/** タブの URL・題・表示の大きさを書き換える（ページが変わった）。同じなら s をそのまま返す。 */
export function updateTab(
  s: TabsState,
  id: string,
  patch: { url?: string; title?: string; zoom?: number },
): TabsState {
  const i = s.tabs.findIndex((t) => t.id === id);
  if (i < 0) return s;
  const t = s.tabs[i];
  const next = { ...t, ...patch };
  if (next.url === t.url && next.title === t.title && next.zoom === t.zoom)
    return s;
  const tabs = [...s.tabs];
  tabs[i] = next;
  return { ...s, tabs };
}

/** 画面に出すタブの名前。つけた名前（name。gws/model.ts の BrowserRef が持つ）、無ければページの題、それも無ければ host。 */
export function tabTitle(
  t: Pick<BrowserTab, "title" | "url">,
  name = "",
): string {
  return name || t.title || hostOf(t.url);
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

/**
 * URL の入力欄に打ったものを、開く URL にする。開けないもの（http と https 以外・host が無い・ユーザー名とパスワード入り・
 * 空白や制御文字を含む）は null。scheme を省くと https（localhost・127.0.0.1・[::1] は http）にする。
 */
export function normalizeUrl(input: string): string | null {
  const s = input.trim();
  if (s === "" || s.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(s))
    return null;
  let full = s;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return null; // javascript: などの、// の無い scheme
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(?=$|[:/?#])/i.test(s);
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

/** 覚えていた表示の大きさ（百分率）を、タブの zoom にする。選べる大きさ（scale.ts の SCALES）でなければ元の大きさ。 */
function zoomOf(percent: unknown): { zoom?: number } {
  if (typeof percent !== "number") return {};
  const z = percent / 100;
  return SCALES.includes(z) && z !== 1 ? { zoom: z } : {};
}
