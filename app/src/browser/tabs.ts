// 内蔵ブラウザのタブ（#202）の、ワークスペースごとの並びと、どれを出しているか。DOM も Tauri も使わない（node --test で確かめられる）。
//
// タブはワークスペースに属する（どのワークスペースにも属さないタブは無い）。タブを選ぶと、グリッドの画面すべてがそのページになり、
// ワークスペースの帯を選ぶと、ターミナルのグリッドに戻る。どれを出しているか（views）はワークスペースごとに覚える。
// タブは、開いたときのワークスペースのマシン（target）を覚える（リモートの localhost の中継で使う。#203）。
// 開いていたタブ（ワークスペースと URL）と、畳んだワークスペースは、殻がデータのフォルダに覚える（browser.rs の StoredTabs と同じ形）。
// どれを出していたか（views）は覚えない（起動したときは、どのワークスペースもグリッドから始める）。

import type { WorkspaceId } from "../rpc/protocol.ts";

/** タブ 1 つ。 */
export interface BrowserTab {
  /** 子の webview のラベルになる id（英数字・- ・_ で 32 字まで） */
  id: string;
  /** 開いたときのワークスペースのマシン（ssh の行き先か `@local`） */
  target: string;
  workspace: WorkspaceId;
  /** 今出しているページの URL（開いた URL から、ページの遷移で変わる） */
  url: string;
  /** ページの題（まだ分からなければ空） */
  title: string;
}

/** タブ全部と、ワークスペースごとの表示。 */
export interface TabsState {
  /** 開いた順。ワークスペースの中の並びも、この順 */
  tabs: readonly BrowserTab[];
  /** ワークスペース（wsKey）→ 出しているタブの id。無ければグリッドを出している */
  views: Readonly<Record<string, string>>;
  /** タブの並びを畳んだワークスペース（wsKey） */
  collapsed: readonly string[];
}

/** 殻が覚える形（browser.rs の StoredTabs）。 */
export interface StoredTabs {
  tabs: {
    id: string;
    target: string;
    workspace: string;
    url: string;
    title: string;
  }[];
  collapsed: { target: string; workspace: string }[];
}

/** タブが 1 つも無い、初めの状態。 */
export const EMPTY_TABS: TabsState = { tabs: [], views: {}, collapsed: [] };

/** ワークスペースを指すキー。 */
export const wsKey = (target: string, id: WorkspaceId): string =>
  JSON.stringify([target, id]);

const inWs = (t: BrowserTab, target: string, ws: WorkspaceId) =>
  t.target === target && t.workspace === ws;

/** ワークスペースのタブ（開いた順）。 */
export function tabsOf(
  s: TabsState,
  target: string,
  ws: WorkspaceId,
): BrowserTab[] {
  return s.tabs.filter((t) => inWs(t, target, ws));
}

/** ワークスペースで出しているタブ。グリッドを出していれば undefined。 */
export function shownTab(
  s: TabsState,
  target: string,
  ws: WorkspaceId,
): BrowserTab | undefined {
  const id = s.views[wsKey(target, ws)];
  return id === undefined
    ? undefined
    : s.tabs.find((t) => t.id === id && inWs(t, target, ws));
}

function withView(
  s: TabsState,
  target: string,
  ws: WorkspaceId,
  id: string | null,
): TabsState {
  const k = wsKey(target, ws);
  const views = { ...s.views };
  if (id === null) delete views[k];
  else views[k] = id;
  return { ...s, views };
}

/** タブを足し（そのワークスペースの最後）、それを出す。 */
export function addTab(s: TabsState, tab: BrowserTab): TabsState {
  return withView(
    { ...s, tabs: [...s.tabs, tab] },
    tab.target,
    tab.workspace,
    tab.id,
  );
}

/** ワークスペースで出すものを替える（null はグリッド）。そのワークスペースに無いタブは出さない。 */
export function showTab(
  s: TabsState,
  target: string,
  ws: WorkspaceId,
  id: string | null,
): TabsState {
  if (id !== null && !s.tabs.some((t) => t.id === id && inWs(t, target, ws)))
    return s;
  return withView(s, target, ws, id);
}

/**
 * タブを閉じる。出していたタブなら、同じワークスペースの次のタブ（無ければ前のタブ、それも無ければグリッド）を出す
 * （ふつうのブラウザで、今のタブを閉じたときと同じ）。
 */
export function closeTab(s: TabsState, id: string): TabsState {
  const tab = s.tabs.find((t) => t.id === id);
  if (!tab) return s;
  const mine = tabsOf(s, tab.target, tab.workspace);
  const i = mine.findIndex((t) => t.id === id);
  const rest = { ...s, tabs: s.tabs.filter((t) => t.id !== id) };
  if (s.views[wsKey(tab.target, tab.workspace)] !== id) return rest;
  const next = mine[i + 1] ?? mine[i - 1];
  return withView(rest, tab.target, tab.workspace, next?.id ?? null);
}

/** グリッドとタブを順に回る（`o j` は グリッド → 1 番目 → 2 番目 → グリッド、`o k` は逆）。 */
export function cycle(
  s: TabsState,
  target: string,
  ws: WorkspaceId,
  step: "next" | "prev",
): TabsState {
  const order: (string | null)[] = [
    null,
    ...tabsOf(s, target, ws).map((t) => t.id),
  ];
  if (order.length === 1) return s;
  const cur = shownTab(s, target, ws)?.id ?? null;
  const i = order.indexOf(cur);
  const d = step === "next" ? 1 : -1;
  return withView(s, target, ws, order[(i + d + order.length) % order.length]);
}

/** タブの並びを畳んでいるか。 */
export function isFolded(
  s: TabsState,
  target: string,
  ws: WorkspaceId,
): boolean {
  return s.collapsed.includes(wsKey(target, ws));
}

/** タブの並びを畳む・開く。 */
export function toggleFold(
  s: TabsState,
  target: string,
  ws: WorkspaceId,
): TabsState {
  const k = wsKey(target, ws);
  return {
    ...s,
    collapsed: s.collapsed.includes(k)
      ? s.collapsed.filter((x) => x !== k)
      : [...s.collapsed, k],
  };
}

/** タブの URL・題を書き換える（ページが変わった）。同じなら s をそのまま返す。 */
export function updateTab(
  s: TabsState,
  id: string,
  patch: { url?: string; title?: string },
): TabsState {
  const i = s.tabs.findIndex((t) => t.id === id);
  if (i < 0) return s;
  const t = s.tabs[i];
  const next = { ...t, ...patch };
  if (next.url === t.url && next.title === t.title) return s;
  const tabs = [...s.tabs];
  tabs[i] = next;
  return { ...s, tabs };
}

/**
 * マシン target のワークスペースの一覧が分かったとき、一覧に無いワークスペース（閉じたもの）のタブと表示を捨てる。
 * つながる前（一覧がまだ分からない）には呼ばない（覚えていたタブを、つながる前に捨てないため）。
 */
export function pruneWorkspaces(
  s: TabsState,
  target: string,
  ids: readonly WorkspaceId[],
): TabsState {
  const alive = new Set(ids.map((id) => wsKey(target, id)));
  const keep = (k: string) => {
    const [t] = JSON.parse(k) as [string, string];
    return t !== target || alive.has(k);
  };
  const tabs = s.tabs.filter(
    (t) => t.target !== target || ids.includes(t.workspace),
  );
  const collapsed = s.collapsed.filter(keep);
  const views = Object.fromEntries(
    Object.entries(s.views).filter(([k]) => keep(k)),
  );
  if (
    tabs.length === s.tabs.length &&
    collapsed.length === s.collapsed.length &&
    Object.keys(views).length === Object.keys(s.views).length
  )
    return s;
  return { tabs, views, collapsed };
}

/** 殻に覚えさせる形。 */
export function toStored(s: TabsState): StoredTabs {
  return {
    tabs: s.tabs.map(({ id, target, workspace, url, title }) => ({
      id,
      target,
      workspace,
      url,
      title,
    })),
    collapsed: s.collapsed.map((k) => {
      const [target, workspace] = JSON.parse(k) as [string, string];
      return { target, workspace };
    }),
  };
}

/** 殻が覚えていたもの。形の違うもの・重なりは捨てる。どれもグリッドから始める。 */
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
      });
  }
  const collapsed: string[] = [];
  for (const c of Array.isArray(o.collapsed) ? o.collapsed : []) {
    if (
      typeof c === "object" &&
      c !== null &&
      typeof c.target === "string" &&
      typeof c.workspace === "string"
    ) {
      const k = wsKey(c.target, c.workspace);
      if (!collapsed.includes(k)) collapsed.push(k);
    }
  }
  return { tabs, views: {}, collapsed };
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
