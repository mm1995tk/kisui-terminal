// 手元の GUI が持つワークスペース（#231）。DOM も Tauri も Solid も使わない（node --test で確かめられる）。
//
// 各マシンの kisui serve が持つ「ワークスペース」（プライマリターミナル・分割したペイン・フォルダ・名前を持つもの）は、
// ここでは「ターミナルのタブ」1 つになる。GUI のワークスペースは、マシンをまたいで、ターミナルのタブと内蔵ブラウザのタブを束ねる。
// 覚えるもの：名前、サイドバーでの並び順（list の順）、中のタブとその並び順。再起動しても残す（置き場は webview の localStorage）。
//
// 名前を付けていないワークスペースは「ws1」「ws2」の番号の名前で出す。番号は作ったときに空いている一番小さい番号で、閉じるまで変えない。
// どのワークスペースにも入っていないターミナルのタブ（記録が消えた・別の PC の GUI から作った・この変更の前から開いていた）は、
// 1 つにつき新しいワークスペースを 1 つ作って入れる（reconcile）。

import type { WorkspaceId } from "../rpc/protocol.ts";
import type { KeyValueStore } from "../ssh/machines.ts";

/** ターミナルのタブ 1 つ（どのマシンの、どのワークスペースか）。 */
export interface TermRef {
  kind: "term";
  target: string;
  ws: WorkspaceId;
  /** 最後に分かったタブの名前（つながっていないマシンのタブを出すのに使う） */
  title: string;
}

/** 内蔵ブラウザのタブ 1 つ（タブの中身は browser/tabs.ts が持つ）。 */
export interface BrowserRef {
  kind: "browser";
  id: string;
  /** タブにつけた名前（無ければ省く。出すときはこれがページの題より先） */
  name?: string;
}

export type TabRef = TermRef | BrowserRef;

/** ワークスペース 1 つ。 */
export interface Gws {
  id: string;
  /** ユーザーが付けた名前（無ければ ""。出すときは displayName） */
  name: string;
  /** 名前を付けていないときの番号（「ws1」の 1）。閉じるまで変えない */
  num: number;
  /** 中のタブ（開いた順。種類では分けない） */
  tabs: TabRef[];
  /** 最後に使っていたターミナルのタブ（無ければ最初のもの） */
  term?: { target: string; ws: WorkspaceId };
  /** タブの並びを畳んでいるか */
  folded?: boolean;
}

export interface GwsState {
  /** サイドバーの並び順 */
  list: Gws[];
}

export const EMPTY_GWS: GwsState = { list: [] };

/** localStorage のキー。 */
export const GWS_KEY = "kisui-terminal.guiWorkspaces";

/** 画面に出す名前。付けていなければ「ws1」。 */
export const displayName = (g: Pick<Gws, "name" | "num">): string =>
  g.name || autoName(g.num);

/** 名前を付けていないときの名前。 */
export const autoName = (num: number): string => `ws${num}`;

/** タブを指すキー（サイドバーの行・出しているタブの印）。 */
export const refKey = (r: TabRef | { target: string; ws: WorkspaceId }) =>
  "kind" in r && r.kind === "browser"
    ? JSON.stringify(["b", r.id])
    : JSON.stringify(["t", (r as TermRef).target, (r as TermRef).ws]);

export const termKey = (target: string, ws: WorkspaceId): string =>
  JSON.stringify(["t", target, ws]);
export const browserKey = (id: string): string => JSON.stringify(["b", id]);

const isTerm = (r: TabRef): r is TermRef => r.kind === "term";

const sameTerm = (r: TabRef, target: string, ws: WorkspaceId) =>
  isTerm(r) && r.target === target && r.ws === ws;

/** 空いている一番小さい番号（1 から）。 */
export function freeNum(list: readonly Pick<Gws, "num">[]): number {
  const used = new Set(list.map((g) => g.num));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** 新しいワークスペースの id。 */
export function newGwsId(random: () => number = Math.random): string {
  let s = "g";
  for (let i = 0; i < 10; i++) s += Math.floor(random() * 36).toString(36);
  return s;
}

/** ターミナルのタブが入っているワークスペース。 */
export function gwsOfTerm(
  s: GwsState,
  target: string,
  ws: WorkspaceId,
): Gws | undefined {
  return s.list.find((g) => g.tabs.some((r) => sameTerm(r, target, ws)));
}

/** ブラウザのタブが入っているワークスペース。 */
export function gwsOfBrowser(s: GwsState, id: string): Gws | undefined {
  return s.list.find((g) =>
    g.tabs.some((r) => r.kind === "browser" && r.id === id),
  );
}

/** ワークスペースの、ターミナルのタブ。 */
export function termsOf(g: Gws): TermRef[] {
  return g.tabs.filter(isTerm);
}

/**
 * ワークスペースが今出すターミナルのタブ。focus（GUI のフォーカス）がこのワークスペースのタブならそれ、
 * そうでなければ最後に使っていたもの、無ければ最初のもの。ターミナルのタブは、いつも 1 つ以上ある。
 */
export function repTerm(
  g: Gws,
  focus?: { target: string; id: WorkspaceId } | null,
): TermRef {
  const terms = termsOf(g);
  const find = (target: string, ws: WorkspaceId) =>
    terms.find((r) => r.target === target && r.ws === ws);
  return (
    (focus ? find(focus.target, focus.id) : undefined) ??
    (g.term ? find(g.term.target, g.term.ws) : undefined) ??
    terms[0]
  );
}

/**
 * ターミナルのタブ 1 つだけを持つ新しいワークスペースを、並びの一番下に足す。
 * そのタブがもうどこかのワークスペースにあれば、そのまま返す。
 */
export function addWorkspace(
  s: GwsState,
  target: string,
  ws: WorkspaceId,
  title = "",
  id: string = newGwsId(),
): GwsState {
  if (gwsOfTerm(s, target, ws)) return s;
  const g: Gws = {
    id,
    name: "",
    num: freeNum(s.list),
    tabs: [{ kind: "term", target, ws, title }],
    term: { target, ws },
  };
  return { list: [...s.list, g] };
}

function update(s: GwsState, id: string, f: (g: Gws) => Gws): GwsState {
  const i = s.list.findIndex((g) => g.id === id);
  if (i < 0) return s;
  const next = f(s.list[i]);
  if (next === s.list[i]) return s;
  const list = s.list.slice();
  list[i] = next;
  return { list };
}

/** 名前を付ける。空にすると、番号の名前に戻る。 */
export function rename(s: GwsState, id: string, name: string): GwsState {
  const n = name.trim();
  return update(s, id, (g) => (g.name === n ? g : { ...g, name: n }));
}

/** ワークスペースを 1 つ上・下へ動かす。端では null。 */
export function move(
  s: GwsState,
  id: string,
  dir: "up" | "down",
): GwsState | null {
  const i = s.list.findIndex((g) => g.id === id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= s.list.length) return null;
  const list = s.list.slice();
  [list[i], list[j]] = [list[j], list[i]];
  return { list };
}

/** 最後に使っていたターミナルのタブを覚える。 */
export function setActiveTerm(
  s: GwsState,
  target: string,
  ws: WorkspaceId,
): GwsState {
  const g = gwsOfTerm(s, target, ws);
  if (!g) return s;
  if (g.term?.target === target && g.term.ws === ws) return s;
  return update(s, g.id, (x) => ({ ...x, term: { target, ws } }));
}

/** タブの並びを畳む・開く。 */
export function toggleFold(s: GwsState, id: string): GwsState {
  return update(s, id, (g) => ({ ...g, folded: !g.folded }));
}

/** ブラウザのタブを、ワークスペースの一番後ろに足す（すでにどこかにあれば何もしない）。 */
export function addBrowser(s: GwsState, id: string, tab: string): GwsState {
  if (gwsOfBrowser(s, tab)) return s;
  return update(s, id, (g) => ({
    ...g,
    tabs: [...g.tabs, { kind: "browser", id: tab }],
  }));
}

/** ブラウザのタブを外す。 */
export function removeBrowser(s: GwsState, tab: string): GwsState {
  const g = gwsOfBrowser(s, tab);
  if (!g) return s;
  return update(s, g.id, (x) => ({
    ...x,
    tabs: x.tabs.filter((r) => !(r.kind === "browser" && r.id === tab)),
  }));
}

/**
 * タブ key を閉じたあとに出すタブ。同じワークスペースの次のタブ（無ければ前）。
 * back（同じワークスペースのブラウザのタブ）を渡すと、次のタブの代わりにそれ（ページが自分を閉じたとき、開いた元へ戻る）。
 * ターミナルのタブが必ず 1 つはあるので、閉じるのがブラウザのタブなら、何かしら返る。
 */
export function after(g: Gws, key: string, back?: string): TabRef | undefined {
  const keys = g.tabs.map(refKey);
  const i = keys.indexOf(key);
  if (back !== undefined) {
    const r = g.tabs.find((t) => t.kind === "browser" && t.id === back);
    if (r && refKey(r) !== key) return r;
  }
  return g.tabs[i + 1] ?? g.tabs[i - 1];
}

/** タブを順に回る（次は後ろ・前は前。端では反対の端へ）。出しているタブ cur から。 */
export function cycleKey(
  g: Gws,
  cur: string,
  step: "next" | "prev",
): TabRef | undefined {
  const n = g.tabs.length;
  if (n <= 1) return undefined;
  const i = g.tabs.map(refKey).indexOf(cur);
  const d = step === "next" ? 1 : n - 1;
  return g.tabs[((i < 0 ? 0 : i) + d) % n];
}

/** reconcile に渡す、マシンのワークスペースの一覧（つながって一覧が分かっているマシンだけ）。 */
export type Lists = Record<
  string,
  readonly { id: WorkspaceId; title: string }[] | undefined
>;

export interface ReconcileInput {
  lists: Lists;
  /**
   * 内蔵ブラウザのタブ全部。まだ読んでいない・内蔵ブラウザを使わないときは undefined
   * （そのときは、ブラウザのタブの記録を捨てず、足しもしない）。
   */
  browser?: readonly { id: string; target: string; workspace: WorkspaceId }[];
  /**
   * この変更の前の並び順の記録（sidebar/order.ts）。新しく作るワークスペースを、この順に並べる。
   * 並びの記録を持たない GUI が初めて一覧を見たときの、並びの移し方
   */
  legacyOrder?: readonly { target: string; id: WorkspaceId }[];
  /**
   * 一覧に無くても外さないターミナルのタブ（termKey）。作ったばかりで、マシンの一覧の知らせがまだ届いていないもの
   */
  keep?: ReadonlySet<string>;
}

export interface Reconciled {
  state: GwsState;
  /** 内蔵ブラウザで閉じるタブ（持ち主のワークスペースが無くなったもの） */
  close: string[];
}

/**
 * マシンの一覧と内蔵ブラウザのタブに、ワークスペースの記録を合わせる。
 * - つながって一覧が分かっているマシンで、一覧に無いタブ（閉じられたもの）は外す。つながっていないマシンのタブは残す。
 * - どこにも入っていないターミナルのタブは、1 つにつき新しいワークスペースを作る。
 * - どこにも入っていないブラウザのタブは、開いたときのターミナルのタブがあるワークスペースに入れる。その元も無ければ（元のマシンの一覧が分かっていて）閉じる。
 * - ターミナルのタブが 1 つも無くなったワークスペースは外し、その中のブラウザのタブは閉じる。
 * 変わらなければ同じ state を返す。
 */
export function reconcile(s: GwsState, input: ReconcileInput): Reconciled {
  const { lists, browser } = input;
  const close: string[] = [];
  const browserIds = browser ? new Set(browser.map((b) => b.id)) : undefined;
  const seen = new Set<string>();

  // 1. 一覧に無いタブを外し、名前を更新する。重なったタブは先のものだけ残す
  let list = s.list.map((g): Gws => {
    const tabs: TabRef[] = [];
    for (const r of g.tabs) {
      const k = refKey(r);
      if (seen.has(k)) continue;
      if (r.kind === "term") {
        const l = lists[r.target];
        if (l) {
          const w = l.find((x) => x.id === r.ws);
          if (!w) {
            if (!input.keep?.has(k)) continue;
            seen.add(k);
            tabs.push(r);
            continue;
          }
          seen.add(k);
          tabs.push(w.title === r.title ? r : { ...r, title: w.title });
          continue;
        }
      } else if (browserIds && !browserIds.has(r.id)) continue;
      seen.add(k);
      tabs.push(r);
    }
    return sameTabs(tabs, g.tabs) ? g : { ...g, tabs };
  });
  let state: GwsState = sameList(list, s.list) ? s : { list };

  // 2. どこにも入っていないターミナルのタブで、新しいワークスペースを作る
  const orphans: { target: string; ws: WorkspaceId; title: string }[] = [];
  for (const [target, l] of Object.entries(lists)) {
    if (!l) continue;
    for (const w of l)
      if (!seen.has(termKey(target, w.id)))
        orphans.push({ target, ws: w.id, title: w.title });
  }
  const legacy = input.legacyOrder ?? [];
  const at = (o: { target: string; ws: WorkspaceId }) => {
    const i = legacy.findIndex((l) => l.target === o.target && l.id === o.ws);
    return i < 0 ? Infinity : i;
  };
  orphans.sort((a, b) => {
    const x = at(a);
    const y = at(b);
    return x === y ? 0 : x < y ? -1 : 1; // 安定な並べ替え。記録に無いものは一覧の順のまま
  });
  for (const o of orphans) state = addWorkspace(state, o.target, o.ws, o.title);

  // 3. どこにも入っていないブラウザのタブ
  if (browser) {
    const claimed = new Set(
      state.list.flatMap((g) =>
        g.tabs
          .filter((r) => r.kind === "browser")
          .map((r) => (r as BrowserRef).id),
      ),
    );
    for (const b of browser) {
      if (claimed.has(b.id)) continue;
      const g = gwsOfTerm(state, b.target, b.workspace);
      if (g) state = addBrowser(state, g.id, b.id);
      else if (lists[b.target]) close.push(b.id);
      // 元のマシンの一覧がまだ分からなければ、分かるまで待つ
    }
  }

  // 4. ターミナルのタブが無くなったワークスペースを外す
  const alive: Gws[] = [];
  for (const g of state.list) {
    if (termsOf(g).length > 0) {
      alive.push(
        g.term && !g.tabs.some((r) => sameTerm(r, g.term!.target, g.term!.ws))
          ? { ...g, term: undefined }
          : g,
      );
      continue;
    }
    for (const r of g.tabs) if (r.kind === "browser") close.push(r.id);
  }
  if (
    alive.length !== state.list.length ||
    alive.some((g, i) => g !== state.list[i])
  )
    state = { list: alive };

  return { state, close };
}

function sameTabs(a: readonly TabRef[], b: readonly TabRef[]): boolean {
  return a.length === b.length && a.every((r, i) => r === b[i]);
}

function sameList(a: readonly Gws[], b: readonly Gws[]): boolean {
  return a.length === b.length && a.every((g, i) => g === b[i]);
}

/** 記録を読む。無い・壊れている・読めないときは空。形の違うものと重なりは捨てる。 */
export function loadGws(store: KeyValueStore | undefined): GwsState | null {
  try {
    const raw = store?.getItem(GWS_KEY);
    if (!raw) return null;
    return parseGws(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 記録を書く。書けなくても、今回の分は変わる。 */
export function saveGws(store: KeyValueStore | undefined, s: GwsState): void {
  try {
    store?.setItem(GWS_KEY, JSON.stringify(s));
  } catch {
    // 保存できなくても、今回は使える
  }
}

/** 記録の形を確かめる。ターミナルのタブが無いワークスペース・重なったものは捨てる。 */
export function parseGws(v: unknown): GwsState {
  if (typeof v !== "object" || v === null) return EMPTY_GWS;
  const raw = (v as { list?: unknown }).list;
  if (!Array.isArray(raw)) return EMPTY_GWS;
  const ids = new Set<string>();
  const nums = new Set<number>();
  const seen = new Set<string>();
  const list: Gws[] = [];
  for (const e of raw) {
    if (typeof e !== "object" || e === null) continue;
    const g = e as Partial<Gws>;
    if (typeof g.id !== "string" || ids.has(g.id)) continue;
    const tabs: TabRef[] = [];
    for (const t of Array.isArray(g.tabs) ? (g.tabs as unknown[]) : []) {
      if (typeof t !== "object" || t === null) continue;
      const r = t as Record<string, unknown>;
      let ref: TabRef | undefined;
      if (
        r.kind === "term" &&
        typeof r.target === "string" &&
        typeof r.ws === "string"
      )
        ref = {
          kind: "term",
          target: r.target,
          ws: r.ws,
          title: typeof r.title === "string" ? r.title : "",
        };
      else if (r.kind === "browser" && typeof r.id === "string")
        ref = {
          kind: "browser",
          id: r.id,
          ...(typeof r.name === "string" && r.name ? { name: r.name } : {}),
        };
      if (!ref || seen.has(refKey(ref))) continue;
      seen.add(refKey(ref));
      tabs.push(ref);
    }
    if (!tabs.some(isTerm)) continue;
    // 番号が壊れている・重なっているときは、空いている番号を振り直す
    const num =
      typeof g.num === "number" &&
      Number.isInteger(g.num) &&
      g.num >= 1 &&
      !nums.has(g.num)
        ? g.num
        : freeNum([...nums].map((n) => ({ num: n })));
    ids.add(g.id);
    nums.add(num);
    const out: Gws = {
      id: g.id,
      name: typeof g.name === "string" ? g.name : "",
      num,
      tabs,
    };
    const t = g.term;
    if (
      t &&
      typeof t.target === "string" &&
      typeof t.ws === "string" &&
      tabs.some((r) => sameTerm(r, t.target, t.ws))
    )
      out.term = { target: t.target, ws: t.ws };
    if (g.folded === true) out.folded = true;
    list.push(out);
  }
  return { list };
}

/** ブラウザのタブに名前を付ける。空にすると、ページの題に戻る。 */
export function renameBrowser(
  s: GwsState,
  tab: string,
  name: string,
): GwsState {
  const g = gwsOfBrowser(s, tab);
  if (!g) return s;
  const n = name.trim();
  return update(s, g.id, (x) => ({
    ...x,
    tabs: x.tabs.map((r) => {
      if (r.kind !== "browser" || r.id !== tab || (r.name ?? "") === n)
        return r;
      const { name: _, ...rest } = r;
      return n ? { ...rest, name: n } : rest;
    }),
  }));
}

/** 名前の長さの上限（文字数。kisui serve のペインの名前と同じ）。 */
export const MAX_NAME = 100;

/** 名前を付けられない理由。付けられるなら undefined。 */
export function nameError(name: string): "too_long" | "control" | undefined {
  const n = name.trim();
  if ([...n].length > MAX_NAME) return "too_long";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(n)) return "control";
  return undefined;
}

/** ターミナルのタブを記録から外す（マシンにつながっていなくて閉じられないとき）。 */
export function dropTerm(
  s: GwsState,
  target: string,
  ws: WorkspaceId,
): GwsState {
  const g = gwsOfTerm(s, target, ws);
  if (!g) return s;
  return update(s, g.id, (x) => ({
    ...x,
    tabs: x.tabs.filter((r) => !sameTerm(r, target, ws)),
  }));
}
