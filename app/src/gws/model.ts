// 手元の GUI が持つワークスペース（#231）。DOM も Tauri も Solid も使わない（node --test で確かめられる）。
//
// 各マシンの kisui serve が持つ「ワークスペース」（プライマリターミナル・分割したペイン・フォルダ・名前を持つもの）は、
// ここでは「ターミナルのタブ」1 つになる。GUI のワークスペースは、マシンをまたいで、ターミナルのタブと内蔵ブラウザのタブを束ねる。
// ターミナルのタブは 1 つも無くてよい（ブラウザのタブだけのワークスペース。#257）。タブが 1 つも無くなったワークスペースは閉じる。
// 覚えるもの：名前、サイドバーでの並び順（list の順）、中のタブとその並び順。再起動しても残す（置き場は webview の localStorage）。
//
// 名前を付けていないワークスペースは「ws1」「ws2」の番号の名前で出す。番号は作ったときに空いている一番小さい番号で、閉じるまで変えない。
// どのワークスペースにも入っていないターミナルのタブ（記録が消えた・別の PC の GUI から作った・GUI のワークスペースの記録が無かった版から開いていた）は、
// 1 つにつき新しいワークスペースを 1 つ作って入れる（reconcile）。

import { T } from "../i18n/index.ts";
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
  /** 最後に使っていたターミナルのタブ（無ければ最初のもの。ターミナルのタブが無いワークスペースには無い） */
  term?: { target: string; ws: WorkspaceId };
  /** タブの並びを畳んでいるか */
  folded?: boolean;
}

export interface GwsState {
  /** サイドバーの並び順 */
  list: Gws[];
}

/** ワークスペースが 1 つも無い、初めの状態。 */
export const EMPTY_GWS: GwsState = { list: [] };

/** localStorage のキー。 */
export const GWS_KEY = "kisui-terminal.guiWorkspaces";

/** 画面に出す名前。付けていなければ「ws1」。 */
export const displayName = (g: Pick<Gws, "name" | "num">): string =>
  g.name || autoName(g.num);

/** 名前を付けていないときの名前。 */
export const autoName = (num: number): string => `ws${num}`;

/** ターミナルのタブ（マシンと、そのマシンのワークスペース）を指すキー。 */
export const termKey = (target: string, ws: WorkspaceId): string =>
  JSON.stringify(["t", target, ws]);

/** ブラウザのタブ（id）を指すキー。 */
export const browserKey = (id: string): string => JSON.stringify(["b", id]);

/** タブを指すキー（サイドバーの行・出しているタブの印）。termKey・browserKey と同じ形。 */
export const refKey = (r: TabRef): string =>
  r.kind === "browser" ? browserKey(r.id) : termKey(r.target, r.ws);

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
 * そうでなければ最後に使っていたもの、無ければ最初のもの。ターミナルのタブが 1 つも無いワークスペースは undefined。
 * up を渡すと、フォーカスのタブでないとき、そのマシンがつながっていなければ（up が false）、つながっているマシンの最初のタブを選び直す
 * （つながっているタブも持つワークスペースに、移れなくなるのを避ける）。つながっているタブが無ければ、そのまま。
 */
export function repTerm(
  g: Gws,
  focus?: { target: string; id: WorkspaceId } | null,
  up?: (target: string) => boolean,
): TermRef | undefined {
  const terms = termsOf(g);
  if (terms.length === 0) return undefined;
  const find = (target: string, ws: WorkspaceId) =>
    terms.find((r) => r.target === target && r.ws === ws);
  const focused = focus ? find(focus.target, focus.id) : undefined;
  if (focused) return focused;
  const last =
    (g.term ? find(g.term.target, g.term.ws) : undefined) ?? terms[0];
  if (!up || up(last.target)) return last;
  return terms.find((r) => up(r.target)) ?? last;
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

/**
 * 並びの中の 1 つを取り出して、beforeAt が指す位置へ入れ直す（無ければ一番後ろ）。
 * 動かさなかったときは同じ配列を返す（呼ぶ側が「変わらなかった」と分かる）。
 */
function placeBefore<T>(
  list: readonly T[],
  from: number,
  beforeAt: (rest: readonly T[]) => number,
): readonly T[] {
  const rest = list.filter((_, i) => i !== from);
  const to = beforeAt(rest);
  const out = rest.slice();
  out.splice(to < 0 ? rest.length : to, 0, list[from]);
  return out.every((x, i) => x === list[i]) ? list : out;
}

/**
 * ワークスペースを、before のワークスペースのすぐ前へ動かす（ドラッグの落とし先。before が null なら一番後ろ）。
 * マシンに関係なく 1 列の中で動かせる。動かさなかったとき（もう、そこにいる・id が無い）は null。
 */
export function moveBefore(
  s: GwsState,
  id: string,
  before: string | null,
): GwsState | null {
  const i = s.list.findIndex((g) => g.id === id);
  if (i < 0 || id === before) return null;
  const list = placeBefore(s.list, i, (rest) =>
    rest.findIndex((g) => g.id === before),
  );
  return list === s.list ? null : { list: list.slice() };
}

/**
 * ワークスペースの中のタブ（key は refKey）を、before のタブのすぐ前へ動かす（before が null なら一番後ろ）。
 * 動かせるのは同じワークスペースの中だけ。before がそのワークスペースのタブでなければ、一番後ろへ動かす（別のワークスペースへは移さない）。
 * 動かさなかったときは null。
 */
export function moveTabBefore(
  s: GwsState,
  id: string,
  key: string,
  before: string | null,
): GwsState | null {
  const g = s.list.find((x) => x.id === id);
  if (!g) return null;
  const i = g.tabs.findIndex((r) => refKey(r) === key);
  if (i < 0 || key === before) return null;
  const tabs = placeBefore(g.tabs, i, (rest) =>
    rest.findIndex((r) => refKey(r) === before),
  );
  return tabs === g.tabs
    ? null
    : update(s, id, (x) => ({ ...x, tabs: tabs.slice() }));
}

/**
 * サイドバーに出ているタブ（t の操作が数える並び。t 1〜9・t J / t K）。ターミナルのタブは全部。
 * ブラウザのタブは、タブがまだあるもの（hasBrowser）だけ（内蔵ブラウザを無効にしたあとも記録は残るが、サイドバーには出ない）。
 */
export function visibleTabs(
  g: Gws,
  hasBrowser: (id: string) => boolean,
): TabRef[] {
  return g.tabs.filter((r) => r.kind === "term" || hasBrowser(r.id));
}

/**
 * t j / t k で移れるタブ。visibleTabs のうち、つながっていないマシンのターミナルのタブ（移れず、止まってしまう）を除く。
 * 今のタブ cur は、つながっていなくても残す（そこから数えるため）。
 */
export function steppableTabs(
  visible: readonly TabRef[],
  up: (target: string) => boolean,
  cur: string,
): TabRef[] {
  return visible.filter(
    (r) => r.kind === "browser" || up(r.target) || refKey(r) === cur,
  );
}

/**
 * ワークスペースの中のタブ（key は refKey）を、サイドバーに出ている並び visible の 1 つ下（dir が "down"）・上（"up"）の隣と入れ替える
 * （リーダーの t J / t K）。出ていないタブは飛び越える。端では回らず、動かさない（動かさなかったときは null）。
 */
export function moveTabStep(
  s: GwsState,
  id: string,
  key: string,
  dir: "up" | "down",
  visible?: readonly TabRef[],
): GwsState | null {
  const g = s.list.find((x) => x.id === id);
  if (!g) return null;
  const list = visible ?? g.tabs;
  const i = list.findIndex((r) => refKey(r) === key);
  if (i < 0) return null;
  const nb = list[dir === "down" ? i + 1 : i - 1];
  if (!nb) return null;
  if (dir === "up") return moveTabBefore(s, id, key, refKey(nb));
  // 下へは、隣のタブのすぐ後ろ（記録の並びで、隣の次のタブの前）へ
  const k = g.tabs.findIndex((r) => refKey(r) === refKey(nb));
  const after = g.tabs[k + 1];
  return moveTabBefore(s, id, key, after ? refKey(after) : null);
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

/**
 * ワークスペース g が今出しているブラウザのタブの id。view は、ワークスペースが出すと覚えているブラウザのタブ（browser/tabs.ts の views）。
 * ターミナルのタブを出していれば undefined。ターミナルのタブが無いワークスペースは、いつもブラウザのタブを出す
 * （view のタブが無ければ、最初のブラウザのタブ）。hasBrowser は、そのブラウザのタブがまだあるか。
 * 画面に出すページ（App.tsx）とサイドバーで強調する行（sidebar/model.ts）は、どちらもこれで決める。
 */
export function shownBrowserId(
  g: Gws,
  view: string | undefined,
  hasBrowser: (id: string) => boolean,
): string | undefined {
  const own = (id: string) =>
    hasBrowser(id) && g.tabs.some((r) => r.kind === "browser" && r.id === id);
  if (view !== undefined && own(view)) return view;
  if (termsOf(g).length > 0) return undefined;
  for (const r of g.tabs) if (r.kind === "browser" && own(r.id)) return r.id;
  return undefined;
}

/**
 * ブラウザのタブ 1 つだけを持つ新しいワークスペースを、並びの一番下に足す（ターミナルのタブは無い。#257）。
 * そのタブがもうどこかのワークスペースにあれば、そのまま返す。
 */
export function addBrowserWorkspace(
  s: GwsState,
  tab: string,
  id: string = newGwsId(),
): GwsState {
  if (gwsOfBrowser(s, tab)) return s;
  const g: Gws = {
    id,
    name: "",
    num: freeNum(s.list),
    tabs: [{ kind: "browser", id: tab }],
  };
  return { list: [...s.list, g] };
}

/** ブラウザのタブを、ワークスペースの一番後ろに足す（すでにどこかにあれば何もしない）。 */
export function addBrowser(s: GwsState, id: string, tab: string): GwsState {
  if (gwsOfBrowser(s, tab)) return s;
  return update(s, id, (g) => ({
    ...g,
    tabs: [...g.tabs, { kind: "browser", id: tab }],
  }));
}

/**
 * ターミナルのタブを、ワークスペース id の一番後ろに足す（「+」のメニューの「ターミナル」）。足したタブを最後に使っていたタブにする。
 * そのタブがもう同じワークスペースにあれば何もしない。作った直後にマシンの一覧の知らせが先に届いて、別のワークスペースとして入ってしまっていたら、
 * そこから外してこちらに入れる（そのワークスペースが空になれば、並びから外す）。
 */
export function addTerm(
  s: GwsState,
  id: string,
  target: string,
  ws: WorkspaceId,
  title = "",
): GwsState {
  const home = s.list.find((g) => g.id === id);
  if (!home || sameGws(gwsOfTerm(s, target, ws), home)) return s;
  const list = s.list.flatMap((g): Gws[] => {
    if (g.id === id)
      return [
        {
          ...g,
          tabs: [...g.tabs, { kind: "term", target, ws, title }],
          term: { target, ws },
        },
      ];
    if (!g.tabs.some((r) => sameTerm(r, target, ws))) return [g];
    const tabs = g.tabs.filter((r) => !sameTerm(r, target, ws));
    return tabs.length === 0 ? [] : [{ ...g, tabs }];
  });
  return { list };
}

const sameGws = (a: Gws | undefined, b: Gws): boolean => a?.id === b.id;

/** ブラウザのタブを外す。ワークスペースの最後のタブだったら、ワークスペースも並びから外す。 */
export function removeBrowser(s: GwsState, tab: string): GwsState {
  const g = gwsOfBrowser(s, tab);
  if (!g) return s;
  return dropEmpty(
    update(s, g.id, (x) => ({
      ...x,
      tabs: x.tabs.filter((r) => !(r.kind === "browser" && r.id === tab)),
    })),
  );
}

/**
 * タブ key を閉じたあとに出すタブ。同じワークスペースの次のタブ（無ければ前）。
 * back（同じワークスペースのブラウザのタブ）を渡すと、次のタブの代わりにそれ（ページが自分を閉じたとき、開いた元へ戻る）。
 * 閉じるのがワークスペースの最後のタブなら undefined（ワークスペースも閉じる）。
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
   * GUI のワークスペースの記録より前の、並び順だけの記録（sidebar/order.ts）。新しく作るワークスペースを、この順に並べる。
   * GUI のワークスペースの記録を持たない GUI が初めて一覧を見たときの、並びの移し方
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
 *   ターミナルのタブから開いたのではないタブ（workspace が空。ブラウザのタブだけのワークスペースのもの。#257）は、新しいワークスペースを作って入れる。
 * - タブが 1 つも無くなったワークスペースは外す。
 * 変わらなければ同じ state を返す。
 */
export function reconcile(s: GwsState, input: ReconcileInput): Reconciled {
  const pruned = pruneTabs(s, input);
  let state = adoptOrphanTerms(pruned.state, pruned.seen, input);
  const adopted = adoptOrphanBrowsers(state, input);
  return { state: dropEmpty(adopted.state), close: adopted.close };
}

/**
 * 一覧に無いタブ（閉じられたもの）と、ブラウザのタブが無くなった記録を外し、ターミナルのタブの名前を最新にする。
 * 重なったタブは先のものだけ残す。seen は、残ったタブのキー。
 */
function pruneTabs(
  s: GwsState,
  input: ReconcileInput,
): { state: GwsState; seen: Set<string> } {
  const { lists, browser } = input;
  const browserIds = browser ? new Set(browser.map((b) => b.id)) : undefined;
  const seen = new Set<string>();
  const list = s.list.map((g): Gws => {
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
  return { state: sameList(list, s.list) ? s : { list }, seen };
}

/** どこにも入っていない（seen に無い）ターミナルのタブで、新しいワークスペースを作る。前の並び順の記録があれば、その順に並べる。 */
function adoptOrphanTerms(
  s: GwsState,
  seen: ReadonlySet<string>,
  input: ReconcileInput,
): GwsState {
  const orphans: { target: string; ws: WorkspaceId; title: string }[] = [];
  for (const [target, l] of Object.entries(input.lists)) {
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
  let state = s;
  for (const o of orphans) state = addWorkspace(state, o.target, o.ws, o.title);
  return state;
}

/**
 * どこにも入っていないブラウザのタブを、開いたときのターミナルのタブがあるワークスペースに入れる。
 * その元も無ければ（元のマシンの一覧が分かっていれば）close に返す。元のマシンの一覧がまだ分からなければ、分かるまで待つ。
 */
function adoptOrphanBrowsers(s: GwsState, input: ReconcileInput): Reconciled {
  const close: string[] = [];
  if (!input.browser) return { state: s, close };
  const claimed = new Set(
    s.list.flatMap((g) =>
      g.tabs.flatMap((r) => (r.kind === "browser" ? [r.id] : [])),
    ),
  );
  let state = s;
  for (const b of input.browser) {
    if (claimed.has(b.id)) continue;
    if (b.workspace === "") {
      state = addBrowserWorkspace(state, b.id);
      continue;
    }
    const g = gwsOfTerm(state, b.target, b.workspace);
    if (g) state = addBrowser(state, g.id, b.id);
    else if (input.lists[b.target]) close.push(b.id);
  }
  return { state, close };
}

/** タブが 1 つも無いワークスペースを外す。最後に使っていたターミナルのタブがもう無ければ、その覚えも消す。 */
function dropEmpty(s: GwsState): GwsState {
  const alive: Gws[] = [];
  for (const g of s.list) {
    if (g.tabs.length === 0) continue;
    alive.push(
      g.term && !g.tabs.some((r) => sameTerm(r, g.term!.target, g.term!.ws))
        ? { ...g, term: undefined }
        : g,
    );
  }
  const same =
    alive.length === s.list.length && alive.every((g, i) => g === s.list[i]);
  return same ? s : { list: alive };
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

/** 記録の形を確かめる。タブが 1 つも無いワークスペース・重なったものは捨てる。 */
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
    if (tabs.length === 0) continue;
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

/** nameError の理由を、名前の入力欄に出す文にする。付けられる名前なら undefined。 */
export function nameErrorText(name: string): string | undefined {
  switch (nameError(name)) {
    case "too_long":
      return T("rename.err.tooLongMax", { max: MAX_NAME });
    case "control":
      return T("rename.err.control");
    default:
      return undefined;
  }
}

/**
 * ターミナルのタブを記録から外す（マシンにつながっていなくて閉じられないとき）。
 * 最後のタブを外したワークスペースは、並びから外す。
 */
export function dropTerm(
  s: GwsState,
  target: string,
  ws: WorkspaceId,
): GwsState {
  const g = gwsOfTerm(s, target, ws);
  if (!g) return s;
  return dropEmpty(
    update(s, g.id, (x) => ({
      ...x,
      tabs: x.tabs.filter((r) => !sameTerm(r, target, ws)),
    })),
  );
}
