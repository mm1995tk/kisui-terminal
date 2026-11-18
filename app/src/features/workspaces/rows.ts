// 左の一覧（D1）に出すものを、接続の状態とワークスペースの一覧から組み立てる。
// 画面の仕組み（Solid）には依存しない。描くのは Sidebar.tsx。
//
// 見た目は親 #271 のモックを元に、マシンの見出しをやめてワークスペースの帯だけを 1 列に並べる（#201）。
// 帯は GUI のワークスペース（features/workspaces/model.ts。#231）1 つが 1 つ。中のターミナルのタブがマシンの kisui serve のワークスペース（Workspace）1 つに当たる。
// 各帯の隅にマシンの名前と状態を出す。ツリー（D2）は ui/main-window/sidebar/file-tree/、上への固定（D3）は Sidebar.tsx、
// マシンごとの色（D4）の決め方と保存は colors.ts。

import { T } from "../../i18n/index.ts";
import type {
  Workspace,
  WorkspaceId,
} from "../../infrastructure/rpc/protocol.ts";
import { LOCAL } from "../sessions/shell.ts";
import { localLabel } from "../sessions/machines.ts";
import type { SessionState } from "../sessions/session.ts";
import { MACHINE_COLORS } from "../sessions/colors.ts";
import type { BrowserTab } from "../browser/tabs.ts";
import { tabTitle } from "../browser/tabs.ts";
import {
  autoName,
  browserKey,
  displayName,
  refKey,
  repTerm,
  shownBrowserId,
  termKey,
  termsOf,
  type BrowserRef,
  type Gws,
  type GwsState,
  type TermRef,
} from "./model.ts";

/** GUI がフォーカスしているワークスペース（どのマシンの、どれか）。 */
export interface WorkspaceFocus {
  target: string;
  id: WorkspaceId;
}

/** 見出しの横の丸。つながっている・つなぎ直している・それ以外。 */
export type Health = "up" | "pending" | "down";

/** フォルダが決まっていないワークスペースの帯の名前。 */
export const unsetTitle = (): string => T("sidebar.noFolder");

/** ワークスペース 1 つ分の帯に出すもの。 */
export interface Band {
  id: WorkspaceId;
  /** 帯の名前。目印（.git / .shijimi-editor/）が無いワークスペースはフォルダのパス。フォルダ未定なら unsetTitle() */
  title: string;
  /** ユーザーがつけた名前（無ければ ""。title は、あればこれになる） */
  label: string;
  /** 名前をつけていないときの title（名前を変える窓の「空なら」に出す） */
  autoTitle: string;
  /** title がパスなら true（等幅で出す） */
  path: boolean;
  /** フォルダ未定か */
  unset: boolean;
  /** 2 行目の全文（ディレクトリ名 · ブランチ (sha)、「git なし」、同じフォルダの 2 つ目からの番号をつなげたもの）。画面は下の dir / branch / sha / note / num を別々に描くので、これはテストでの確かめ用 */
  detail: string;
  /** 2 行目の先頭に出すディレクトリ名。名前を変えた帯だけ（名前を変えていない帯は、1 行目がディレクトリ名）。無ければ "" */
  dir: string;
  /** ブランチ名。detached HEAD・git なしなら "" */
  branch: string;
  /** HEAD の short sha。読めなければ "" */
  sha: string;
  /** 「git なし」（git の無いフォルダ）。それ以外は "" */
  note: string;
  /** 同じフォルダの 2 つ目からの番号（「#2」）。無ければ "" */
  num: string;
  /** ツールチップに出すフォルダのパス（未定なら ""） */
  root: string;
  focused: boolean;
  /** プライマリターミナルで TUI の shj が動いているか。動いているときだけツリーを出す */
  showTree: boolean;
}

/** マシン 1 台分（見出しと、その下の帯）に出すもの。 */
export interface MachineGroup {
  target: string;
  /** 見出しの文字（ローカル / 付けた名前 / ssh の行き先） */
  label: string;
  /** 名前を変えたり外したり切ったりできるか（「ローカル」はできない） */
  removable: boolean;
  /** 設定ファイル（config.toml か config.local.toml の [[gui.machines]]）で決めたマシンか。外せず、名前も変えられない */
  fixed: boolean;
  /** マシンの色（D4）。見出しと帯の左端の線などに使う */
  color: string;
  health: Health;
  bands: Band[];
}

/** つなぎ先の表示名（名前を付けていないとき）。 */
export const machineLabel = (t: string): string =>
  t === LOCAL ? localLabel() : t;

/** 見出しの丸の色分け。 */
export function health(s: SessionState | undefined): Health {
  switch (s?.kind) {
    case "connected":
      return "up";
    case "connecting":
    case "reconnecting":
    case "installing":
      return "pending";
    default:
      return "down";
  }
}

/**
 * ワークスペース 1 つを帯にする。nth は、同じマシンで同じフォルダを指す何番目のワークスペースか（1 から）。
 * 同じフォルダのワークスペースは名前が同じになるので、2 つ目からは番号を付けて見分ける。
 * ユーザーがつけた名前（w.label）があれば、帯の名前はそれになる（番号は付けない。ブランチなどはそのまま出す）。
 */
export function band(w: Workspace, focused: boolean, nth = 1): Band {
  const label = w.label ?? "";
  const auto = autoBand(w, focused, label ? 1 : nth);
  if (!label) return auto;
  // 名前を変えた帯は、1 行目がディレクトリ名でなくなるので、2 行目の先頭にディレクトリ名を足す
  const dir = w.folder === null ? "" : w.name || w.folder;
  return {
    ...auto,
    title: label,
    label,
    path: false,
    unset: false,
    dir,
    detail: detailText(dir, auto.branch, auto.sha, auto.note, auto.num),
  };
}

/** ブランチと short sha を「main (9e11274)」の形にする。ブランチが無ければ「(9e11274)」、sha が無ければブランチだけ。 */
export function branchText(branch: string, sha: string): string {
  if (!sha) return branch;
  return branch ? `${branch} ${shaText(sha)}` : shaText(sha);
}

/** 名前を変えた帯の 2 行目で、ディレクトリ名とその後ろを分ける字。 */
export const DIR_SEP = "·";

/** short sha を「(9e11274)」の形にする。 */
export const shaText = (sha: string): string => `(${sha})`;

/** 2 行目の全文。ディレクトリ名は「 · 」で区切り、残りは空白でつなぐ。 */
function detailText(
  dir: string,
  branch: string,
  sha: string,
  note: string,
  num: string,
): string {
  const rest = [branchText(branch, sha), note, num].filter(Boolean).join(" ");
  return dir && rest ? `${dir} ${DIR_SEP} ${rest}` : dir || rest;
}

function autoBand(w: Workspace, focused: boolean, nth: number): Band {
  const num = nth > 1 ? `#${nth}` : "";
  if (w.folder === null) {
    return {
      id: w.id,
      title: unsetTitle(),
      label: "",
      autoTitle: unsetTitle(),
      path: false,
      unset: true,
      detail: "",
      dir: "",
      branch: "",
      sha: "",
      note: "",
      num: "",
      root: "",
      focused,
      showTree: w.primaryShj != null,
    };
  }
  const shown = w.display || w.folder;
  const title = w.kind === "cwd" ? shown : w.name || shown;
  const branch = w.kind === "cwd" ? "" : (w.branch ?? "");
  const sha = w.kind === "cwd" ? "" : (w.sha ?? "");
  const note = w.kind === "cwd" ? T("sidebar.noGit") : "";
  return {
    id: w.id,
    title,
    label: "",
    autoTitle: title,
    path: w.kind === "cwd" || !w.name,
    unset: false,
    detail: detailText("", branch, sha, note, num),
    dir: "",
    branch,
    sha,
    note,
    num,
    root: w.folder,
    focused,
    showTree: w.primaryShj != null,
  };
}

/**
 * 一覧を組み立てる。targets はつないだ（つなごうとしている）つなぎ先で、この順に並べる。
 * 帯は shj の workspace.list と同じく作った順。
 * colors はつなぎ先 → 色（colors.ts の machineColors）。無いつなぎ先は候補の最初の色にする。
 * labelOf は見出しの文字（省くと machineLabel）。
 * fixedOf は設定ファイルで決めたマシンか（省くと全部 false）。
 */
export function buildSidebar(
  targets: string[],
  states: Record<string, SessionState | undefined>,
  workspaces: Record<string, Workspace[] | undefined>,
  focus: WorkspaceFocus | null,
  colors: Record<string, string> = {},
  labelOf: (target: string) => string = machineLabel,
  fixedOf: (target: string) => boolean = () => false,
): MachineGroup[] {
  return targets.map((target) => {
    const ws = workspaces[target] ?? [];
    const seen = new Map<string, number>();
    const nth = ws.map((w) => {
      if (w.folder === null || w.label) return 1; // 名前をつけたものは、番号を数えない（帯にも付けない）
      const n = (seen.get(w.folder) ?? 0) + 1;
      seen.set(w.folder, n);
      return n;
    });
    return {
      target,
      label: labelOf(target),
      removable: target !== LOCAL,
      fixed: fixedOf(target),
      color: colors[target] ?? MACHINE_COLORS[0],
      health: health(states[target]),
      bands: ws.map((w, i) =>
        band(w, focus?.target === target && focus.id === w.id, nth[i]),
      ),
    };
  });
}

/**
 * shj が教えてくれたフォーカスを GUI のフォーカスに反映する。GUI のフォーカスは 1 つなので、
 * フォーカスが無ければそれを使い、同じマシンのものなら追い（null なら外す）、別のマシンのものでは動かさない。
 */
export function adoptFocus(
  current: WorkspaceFocus | null,
  target: string,
  shjFocus: WorkspaceId | null,
): WorkspaceFocus | null {
  if (current) {
    // 同じマシンで shj のフォーカスが変われば追い、消えれば外す
    if (current.target === target && shjFocus !== current.id) {
      return shjFocus === null ? null : { target, id: shjFocus };
    }
    return current;
  }
  return shjFocus === null ? null : { target, id: shjFocus };
}

/**
 * 一覧が変わった・切った・フォーカスが外れたあとに、フォーカス先がまだあるかを確かめる。
 * 無くなっていたら、先に決めておいた移り先（prefer。フォーカスしているワークスペースを閉じたときの隣）が一覧にあればそれを、
 * 無ければほかのマシンの shj のフォーカス（shjFocus の順）のうち一覧にあるものを使う
 * （起動直後の「先に分かったものを使う」に合わせ、印の無い状態を続けない）。どれも無ければ null。
 */
export function keepFocus(
  current: WorkspaceFocus | null,
  workspaces: Record<string, Workspace[] | undefined>,
  shjFocus: Record<string, WorkspaceId | null | undefined> = {},
  prefer: WorkspaceFocus | null = null,
): WorkspaceFocus | null {
  const exists = (f: WorkspaceFocus) =>
    workspaces[f.target]?.some((w) => w.id === f.id) ?? false;
  if (current && exists(current)) return current;
  if (prefer && exists(prefer)) return prefer;
  for (const [target, id] of Object.entries(shjFocus)) {
    if (id == null) continue;
    const f = { target, id };
    if (exists(f)) return f;
  }
  return null;
}

/**
 * フォーカスしているワークスペースを閉じたあと、移り先（moveTo）を shj に workspace.focus で伝えてよいか。
 * GUI のフォーカスがまだ移り先を指していて、移り先が一覧に残っているときだけ true。
 * 閉じる返事を待つあいだにユーザーが別の帯を選んだ・移り先も閉じられた、なら伝えない
 * （選んだフォーカスを古い移り先で上書きしない。無いワークスペースに移ろうとして断られない）。
 */
export function shouldSendMoveTo(
  current: WorkspaceFocus | null,
  moveTo: WorkspaceFocus,
  workspaces: Record<string, Workspace[] | undefined>,
): boolean {
  return (
    current?.target === moveTo.target &&
    current.id === moveTo.id &&
    (workspaces[moveTo.target]?.some((w) => w.id === moveTo.id) ?? false)
  );
}

/** サイドバーの 1 行（GUI のワークスペース 1 つ）。帯に、今出しているターミナルのタブのマシンの名前・色・つながりの状態を添える。 */
export interface Row {
  /** GUI のワークスペースの id（features/workspaces/model.ts） */
  gws: string;
  /**
   * 今出しているターミナルのタブのマシン（band.id がそのワークスペース。ツリー・CHANGES・shj はそのタブのもの）。
   * ターミナルのタブが無いワークスペース（ブラウザのタブだけ #257・空 #307）は ""（band.id は GUI のワークスペースの id。ターミナルのタブは無いので、マシンの名前も出さない）
   */
  target: string;
  /** マシンの名前（行の隅に小さく出す） */
  machine: string;
  /** マシンの色（D4）。タブの行のマシンの札などに使う */
  color: string;
  health: Health;
  band: Band;
  /** 帯の下のタブの並び */
  tabs: BandTabs;
}

/** 帯の下に並べるタブの行（ターミナルのタブもブラウザのタブも）。 */
export interface TabItem {
  /** タブを指すキー（features/workspaces/model.ts の refKey） */
  key: string;
  kind: "term" | "browser";
  /** タブの名前 */
  title: string;
  /** 2 行目：ターミナルのタブはフォルダのパス（ホームは ~）、ブラウザのタブは URL。分からなければ "" */
  path: string;
  /** 3 行目（ターミナルのタブだけ）：「ブランチ (short sha)」。git が無いフォルダ・分からないときは ""（行を出さない） */
  git: string;
  /** ツールチップ（ブラウザのタブは URL、ターミナルのタブはフォルダ） */
  tip: string;
  /** シークレットのタブか */
  incognito: boolean;
  /** ブラウザのタブのページの favicon（#237。PNG の data: URL）。無ければ地球のアイコン */
  favicon?: string;
  /** ターミナルのタブのマシン（札に出す。ブラウザのタブは undefined） */
  machine?: { name: string; color: string; health: Health };
  /** ターミナルのタブのマシンとのつながり（ブラウザのタブは undefined）。"down" の行は薄く出す */
  health?: Health;
  /** ブラウザのタブの id（ターミナルのタブは undefined） */
  tab?: string;
  /** ターミナルのタブのマシンとワークスペース（ブラウザのタブは undefined） */
  term?: { target: string; ws: WorkspaceId };
  /** 行の ✕ を出すか（どのタブもいつも。最後のタブを閉じても、ワークスペースは空のまま残る。#307） */
  closable: boolean;
}

/** 帯の下に並べるタブ。 */
export interface BandTabs {
  items: TabItem[];
  /** 出しているタブのキー（空のワークスペースは ""） */
  shown: string;
  /** そのワークスペースにフォーカスしているか（出しているタブを強く光らせる） */
  focused: boolean;
}

/** gwsRows の材料。 */
export interface RowContext {
  /** マシンごとの組（buildSidebar の結果） */
  groups: readonly MachineGroup[];
  /** マシンごとのワークスペース（ターミナルのタブ）の一覧 */
  workspaces: Record<string, Workspace[] | undefined>;
  focus: WorkspaceFocus | null;
  /**
   * GUI が今いるワークスペースの id。ターミナルのタブが無いワークスペース（#257）にいるときは、focus（ターミナルのタブのフォーカス）と食い違うので別に渡す。
   * 省くと、focus のターミナルのタブがあるワークスペース
   */
  current?: string;
  /** ブラウザのタブ（id → タブ）。内蔵ブラウザを使わなければ空 */
  browser: ReadonlyMap<string, BrowserTab>;
  /** ワークスペースの id → 出しているブラウザのタブの id */
  views: Readonly<Record<string, string>>;
  labelOf: (target: string) => string;
  colorOf: (target: string) => string;
  healthOf: (target: string) => Health;
}

/**
 * GUI のワークスペースを、サイドバーの行にする（並びは state.list の順）。
 * 行の帯は、そのワークスペースが今出しているターミナルのタブ（repTerm）で作る：マシンの名前・色・つながり、フォルダ・ブランチ。
 * 帯の名前は、ワークスペースの名前（付けていなければ「ws1」）。
 * マシンにつながっていなくて一覧が分からないタブは、最後に分かった名前で薄く出す（health は "down"）。
 */
export function gwsRows(state: GwsState, ctx: RowContext): Row[] {
  return state.list.flatMap((g): Row[] => {
    const rep = repTerm(g, ctx.focus, (t) => ctx.healthOf(t) === "up");
    const focused =
      ctx.current !== undefined
        ? g.id === ctx.current
        : g.tabs.some(
            (r) =>
              r.kind === "term" &&
              r.target === ctx.focus?.target &&
              r.ws === ctx.focus.id,
          );
    const items = g.tabs.flatMap((r) => {
      const item = r.kind === "term" ? termItem(r, ctx) : browserItem(r, ctx);
      return item ? [item] : [];
    });
    const tabs = (shown: string): BandTabs => ({
      items,
      shown,
      focused,
    });
    if (!rep) {
      // ターミナルのタブが無いワークスペース。ブラウザのタブはあるのに 1 つも出せなければ（内蔵ブラウザを無効にしている）、行を出さない
      // （記録は残すので、有効に戻せばまた出る）。タブが 1 つも無い空のワークスペース（#307）は出す
      if (items.length === 0 && g.tabs.length > 0) return [];
      const shown = shownBrowserId(g, ctx.views[g.id], (id) =>
        ctx.browser.has(id),
      );
      return [
        {
          gws: g.id,
          target: "",
          machine: "",
          color: ctx.colorOf(""),
          health: "up",
          band: bandOfTermless(g, focused),
          tabs: tabs(shown === undefined ? "" : browserKey(shown)),
        },
      ];
    }
    return [
      {
        gws: g.id,
        target: rep.target,
        machine: ctx.labelOf(rep.target),
        color: ctx.colorOf(rep.target),
        health: ctx.healthOf(rep.target),
        band: bandOf(g, rep, focused, ctx),
        tabs: tabs(shownKey(rep, ctx.views[g.id], items)),
      },
    ];
  });
}

/** ターミナルのタブが無いワークスペースの帯（ワークスペースの名前だけ。フォルダ・ブランチ・ツリーは無い）。id は GUI のワークスペースの id。 */
function bandOfTermless(g: Gws, focused: boolean): Band {
  return {
    id: g.id,
    title: displayName(g),
    label: g.name,
    autoTitle: autoName(g.num),
    path: false,
    unset: false,
    detail: "",
    dir: "",
    branch: "",
    sha: "",
    note: "",
    num: "",
    root: "",
    focused,
    showTree: false,
  };
}

/** 行が、ターミナルのタブが無いワークスペース（ブラウザのタブだけ #257・空 #307）のものか。そのときの target は ""（Row.target） */
export const isTermless = (r: Pick<Row, "target">): boolean => r.target === "";

/**
 * ワークスペースの帯。rep（今出しているターミナルのタブ）の一覧があればフォルダ・ブランチを出し、
 * 無ければ（つながっていない）最後に分かった名前を 2 行目に出す。帯の名前はワークスペースの名前。
 */
function bandOf(g: Gws, rep: TermRef, focused: boolean, ctx: RowContext): Band {
  const w = ctx.workspaces[rep.target]?.find((x) => x.id === rep.ws);
  const name = displayName(g);
  if (w)
    return {
      ...band({ ...w, label: name }, focused),
      label: g.name,
      autoTitle: autoName(g.num),
    };
  return {
    id: rep.ws,
    title: name,
    label: g.name,
    autoTitle: autoName(g.num),
    path: false,
    unset: false,
    detail: rep.title,
    dir: rep.title,
    branch: "",
    sha: "",
    note: "",
    num: "",
    root: "",
    focused,
    showTree: false,
  };
}

/** ターミナルのタブの行。名前はマシンの一覧にあればその名前、無ければ最後に分かった名前。 */
function termItem(r: TermRef, ctx: RowContext): TabItem {
  const tw = ctx.workspaces[r.target]?.find((x) => x.id === r.ws);
  const health = ctx.healthOf(r.target);
  const git =
    tw && tw.kind !== "cwd" ? branchText(tw.branch ?? "", tw.sha ?? "") : "";
  const path = tw ? (tw.display ?? tw.folder ?? "") : "";
  return {
    key: refKey(r),
    kind: "term",
    title: tw ? band(tw, false).title : r.title || unsetTitle(),
    path,
    git,
    tip: tw?.folder ?? "",
    incognito: false,
    machine: {
      name: ctx.labelOf(r.target),
      color: ctx.colorOf(r.target),
      health,
    },
    health,
    term: { target: r.target, ws: r.ws },
    closable: true,
  };
}

/** ブラウザのタブの行。タブがもう無ければ undefined（行を出さない）。 */
function browserItem(r: BrowserRef, ctx: RowContext): TabItem | undefined {
  const t = ctx.browser.get(r.id);
  if (!t) return undefined;
  const title = tabTitle(t, r.name);
  return {
    key: refKey(r),
    kind: "browser",
    tab: r.id,
    title,
    path: t.url,
    git: "",
    tip: t.url,
    incognito: !!t.incognito,
    ...(t.favicon ? { favicon: t.favicon } : {}),
    closable: true,
  };
}

/** 出しているタブのキー。ブラウザのタブを出している（view）ならそれ、そうでなければ rep のターミナルのタブ。 */
function shownKey(
  rep: TermRef,
  view: string | undefined,
  items: readonly TabItem[],
): string {
  return view !== undefined && items.some((i) => i.key === browserKey(view))
    ? browserKey(view)
    : termKey(rep.target, rep.ws);
}

/**
 * サイドバーに出す行（フォーカスしているワークスペース）と、その並びの中での位置。
 * フォーカスしている行が無ければ null（ワークスペースが 1 つも無いときなど）。
 */
export interface FocusedRow {
  row: Row;
  /** 並びの何番目か（1 から） */
  index: number;
  /** 全部でいくつか */
  total: number;
}

/** 一覧から、フォーカスしている行を取り出す。 */
export function focusedRow(rows: readonly Row[]): FocusedRow | null {
  const i = rows.findIndex((r) => r.band.focused);
  if (i < 0) return null;
  return { row: rows[i], index: i + 1, total: rows.length };
}

/** キーで移る向き。サイドバーで下・次は "next"、上・前は "prev"。 */
export type Step = "next" | "prev";

/**
 * キーで続けて移るときの起点。移っている途中（返事を待っている）なら向かっている先、そうでなければ今のフォーカス。
 * 返事が返るまでフォーカスは前のままなので、起点を向かっている先にしないと、続けて押しても 1 つしか進まない。
 */
export function stepFrom(
  heading: WorkspaceFocus | null,
  current: WorkspaceFocus | null,
): WorkspaceFocus | null {
  return heading ?? current;
}

/**
 * サイドバーの次・前のワークスペース（1 列の並びで）。端では反対の端へ回る。
 * 今のフォーカスが無い（または並びに無い）ときは、次なら先頭、前なら末尾。ワークスペースが 1 つも無ければ null。
 */
export function stepWorkspace(
  rows: readonly { target: string; band: { id: WorkspaceId } }[],
  current: WorkspaceFocus | null,
  step: Step,
): WorkspaceFocus | null {
  const all = rows.map((r) => ({ target: r.target, id: r.band.id }));
  if (all.length === 0) return null;
  const i = current
    ? all.findIndex((w) => w.target === current.target && w.id === current.id)
    : -1;
  if (i < 0) return step === "next" ? all[0] : all[all.length - 1];
  return all[(i + (step === "next" ? 1 : all.length - 1)) % all.length];
}

/** 出しているタブがブラウザのタブか。そうなら、ファイルツリーと CHANGES を隠す（#268）。出しているタブのキーが items に無ければ false。 */
export function shownIsBrowser(tabs: BandTabs): boolean {
  return tabs.items.some((i) => i.key === tabs.shown && i.kind === "browser");
}

/** タブの段が、見せるかどうかを決めるときの、ある時点のタブ（#284）。 */
export interface TabsSnapshot {
  gws: string;
  keys: string[];
  shown: string;
}

/**
 * タブの段で、見える所までスクロールするタブのキー（無ければ undefined）。
 * - 初めて描いたとき・別のワークスペースに移ったとき・タブが空から一度に埋まったとき（起動直後に後から届く）：出しているタブ
 * - 出しているタブが替わったとき：出しているタブ（足したタブが出ることが多いので、足したタブより先）
 * - 出しているタブは同じで、タブが増えたとき：増えたうちの最後のタブ
 * - 減った・並べ替えただけのとき：スクロールしない
 */
export function tabToReveal(
  prev: TabsSnapshot | undefined,
  now: TabsSnapshot,
): string | undefined {
  const shown = now.keys.includes(now.shown) ? now.shown : undefined;
  if (!prev || prev.gws !== now.gws || prev.keys.length === 0) return shown;
  if (prev.shown !== now.shown) return shown;
  const added = now.keys.filter((k) => !prev.keys.includes(k));
  return added[added.length - 1];
}
