// 左の一覧のツリー（D2）の状態。1 つのワークスペースの、開いているフォルダ・取った中身・git の印・
// スクロールの位置を持つ。画面の仕組み（Solid）にも接続にも依存しない。送り受けは trees.ts、描くのは TreeView.tsx。
//
// 設計書 3 章「ファイルのツリー」：開閉とスクロールの位置は GUI が持つ。フォルダを開いたら tree.list で
// 1 階層取り、tree.watch で開いているフォルダを教え、tree.changed で取り直す。git の印は git.status と
// git.changed、フォルダの印は gitChildren から GUI が求める。

import type {
  Files,
  GitMark,
  Notifications,
  Requests,
  TreeEntry,
} from "../rpc/protocol.ts";
import { RpcError } from "../rpc/message.ts";
import { iconFor, type TreeIcon } from "./icons.ts";

/** ルートのパス（tree.list の path と同じ）。 */
export const ROOT = "";

/** 1 つのフォルダについて、最後に取った中身。 */
export interface Listing {
  entries: TreeEntry[];
  truncated: boolean;
}

type ListResult = Requests["tree.list"]["result"];
type GitStatus = Requests["git.status"]["result"];
type GitChanged = Notifications["git.changed"];

/** 1 つのワークスペースのツリーの状態。関数はどれも新しい値を返し、引数は書き換えない。 */
export interface TreeState {
  /** フォルダのパス → 取った中身。閉じても捨てない（開き直したときにすぐ出す） */
  listings: Record<string, Listing>;
  /** 開いているフォルダ。親を閉じても子の開閉は覚えておく */
  expanded: Record<string, true>;
  /** フォルダごとの「これより古い tree.list の返事は捨てる」版（tree.changed の rev） */
  minRev: Record<string, number>;
  /** git.status / git.changed で知った全体の印。null はまだ知らない（tree.list の git を使う） */
  marks: Record<string, GitMark> | null;
  /** marks の版（git.status / git.changed の rev） */
  gitRev: number;
  /** git.status の返事より先に来た git.changed（返事のあとに版の新しいものだけ当てる） */
  pendingGit: GitChanged[];
  /** 左の一覧のスクロールの位置（px）。フォーカスを外して戻したときに戻す */
  scrollTop: number;
}

/** まだ何も取っていない・何も開いていないツリー。 */
export function emptyTree(): TreeState {
  return {
    listings: {},
    expanded: {},
    minRev: {},
    marks: null,
    gitRev: -1,
    pendingGit: [],
    scrollTop: 0,
  };
}

/** 親フォルダのパス（ルート直下なら ROOT）。 */
export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? ROOT : path.slice(0, i);
}

/** フォルダのパスと名前をつなぐ（ルートなら名前だけ）。 */
export function joinPath(dir: string, name: string): string {
  return dir === ROOT ? name : `${dir}/${name}`;
}

/** path は prefix そのものか、その中か。 */
function within(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** 画面に出ている（ルートからたどって親が全部開いている）か。ルートはいつも出ている。 */
function visible(s: TreeState, dir: string): boolean {
  for (let p = dir; p !== ROOT; p = parentOf(p)) {
    if (!s.expanded[p]) return false;
  }
  return true;
}

/**
 * tree.watch で教えるフォルダ：ルートと、画面に出ている開いたフォルダ。
 * 順番はパスの順（送るたびに並びが変わらないように）。
 */
export function watchPaths(s: TreeState): string[] {
  const open = Object.keys(s.expanded).filter((p) => visible(s, p));
  return [ROOT, ...open.sort()];
}

/** フォルダを開く・閉じる。開いたときに中身を取り直すかどうかは呼ぶ側（trees.ts）が決める。 */
export function toggle(s: TreeState, dir: string): TreeState {
  if (s.expanded[dir]) {
    const { [dir]: _, ...rest } = s.expanded;
    return { ...s, expanded: rest };
  }
  return { ...s, expanded: { ...s.expanded, [dir]: true } };
}

/**
 * tree.list の返事を当てる。tree.changed で知った版より古い返事は捨てる（同じ s を返す）。
 * 中身から消えたフォルダは、開いていた印と取った中身も消す（tree.watch で消えたパスを送らないため）。
 */
export function applyList(s: TreeState, dir: string, r: ListResult): TreeState {
  if (r.rev < (s.minRev[dir] ?? 0)) return s;
  const dirs = new Set(
    r.entries.filter((e) => isDir(e)).map((e) => joinPath(dir, e.name)),
  );
  const gone = (p: string) =>
    p !== dir && within(p, dir) && ![...dirs].some((d) => within(p, d));
  const listings: Record<string, Listing> = {};
  for (const [p, l] of Object.entries(s.listings)) {
    if (!gone(p)) listings[p] = l;
  }
  listings[dir] = { entries: r.entries, truncated: r.truncated ?? false };
  const expanded: Record<string, true> = {};
  for (const p of Object.keys(s.expanded)) {
    if (!gone(p)) expanded[p] = true;
  }
  return { ...s, listings, expanded };
}

/**
 * フォルダが読めなかった（消えた・入れない）。開いていた印と取った中身を、その中のものごと消す。
 */
export function dropDir(s: TreeState, dir: string): TreeState {
  const keep = <T>(m: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(m).filter(([p]) => dir === ROOT || !within(p, dir)),
    ) as Record<string, T>;
  return { ...s, listings: keep(s.listings), expanded: keep(s.expanded) };
}

/**
 * tree.changed を当てる。版を覚え（それより古い返事を捨てるため）、取り直すフォルダを返す
 * （画面に出ているものだけ。閉じたフォルダは開いたときに取り直す）。
 */
export function applyTreeChanged(
  s: TreeState,
  paths: string[],
  rev: number,
): { state: TreeState; refetch: string[] } {
  const minRev = { ...s.minRev };
  for (const p of paths) minRev[p] = Math.max(minRev[p] ?? 0, rev);
  const state = { ...s, minRev };
  return {
    state,
    refetch: paths.filter((p) => visible(state, p)),
  };
}

/** git.status の返事を当てる。それより先に来た git.changed のうち、版の新しいものを続けて当てる。 */
export function applyGitStatus(s: TreeState, r: GitStatus): TreeState {
  if (r.rev < s.gitRev) return s;
  let next: TreeState = {
    ...s,
    marks: { ...r.marks },
    gitRev: r.rev,
    pendingGit: [],
  };
  for (const c of s.pendingGit) next = applyGitChanged(next, c);
  return next;
}

/**
 * git.changed を当てる。版が古い（すでに知っている）ものは捨てる。
 * git.status の返事がまだなら、返事が来るまでとっておく。
 */
export function applyGitChanged(s: TreeState, c: GitChanged): TreeState {
  if (s.marks === null) return { ...s, pendingGit: [...s.pendingGit, c] };
  if (c.rev <= s.gitRev) return s;
  const marks = { ...s.marks };
  for (const [p, m] of Object.entries(c.marks ?? {})) {
    if (m === null) delete marks[p];
    else marks[p] = m;
  }
  return { ...s, marks, gitRev: c.rev };
}

/** git の印を、まだ知らない状態に戻す（つなぎ直したときなど。tree.list の git を使う）。 */
export function forgetGit(s: TreeState): TreeState {
  return { ...s, marks: null, gitRev: -1, pendingGit: [], minRev: {} };
}

/** フォルダとして並べるか（フォルダを指すシンボリックリンクは、shj が並べ方で先に出す。開けるのは dir だけ）。 */
function isDir(e: TreeEntry): boolean {
  return e.kind === "dir";
}

/** 行の右に出す印。 */
export type RowMark =
  | { kind: "file"; letter: Exclude<GitMark, "!"> }
  /** 中に印のあるものがあるフォルダ（TUI と同じく「•」） */
  | { kind: "children" }
  | { kind: "ignored" };

/** 画面の 1 行。 */
export interface TreeRow {
  path: string;
  name: string;
  /** ルート直下が 0 */
  depth: number;
  dir: boolean;
  expanded: boolean;
  /** 開いているが、まだ中身を取れていない */
  loading: boolean;
  symlink: boolean;
  icon: TreeIcon;
  mark: RowMark | null;
  /** 5000 件で切れたフォルダの最後に出す「ここから先は出していない」の行（name は空、icon は使わない） */
  truncated?: true;
}

/** 印のあるもの全部の親フォルダ（フォルダの「•」を求める）。 */
function dirtyDirs(marks: Record<string, GitMark>): Set<string> {
  const out = new Set<string>();
  for (const p of Object.keys(marks)) {
    for (let d = parentOf(p); d !== ROOT && !out.has(d); d = parentOf(d)) {
      out.add(d);
    }
  }
  return out;
}

function markOf(
  e: TreeEntry,
  path: string,
  marks: Record<string, GitMark> | null,
  dirty: Set<string>,
): RowMark | null {
  // 無視されているかは tree.list の git だけが教える（git.status の marks には入らない）
  if (e.git === "!") return { kind: "ignored" };
  const letter = marks ? marks[path] : e.git;
  if (letter && letter !== "!") return { kind: "file", letter };
  if (isDir(e) && (marks ? dirty.has(path) : e.gitChildren)) {
    return { kind: "children" };
  }
  return null;
}

/** 画面に出す行を、上から順に並べる。ルートを取れていなければ空。 */
export function rows(s: TreeState): TreeRow[] {
  const out: TreeRow[] = [];
  const dirty = s.marks ? dirtyDirs(s.marks) : new Set<string>();
  const walk = (dir: string, depth: number) => {
    const l = s.listings[dir];
    if (!l) return;
    for (const e of l.entries) {
      const path = joinPath(dir, e.name);
      const dir_ = isDir(e);
      const expanded = dir_ && !!s.expanded[path];
      out.push({
        path,
        name: e.name,
        depth,
        dir: dir_,
        expanded,
        loading: expanded && !s.listings[path],
        symlink: e.kind === "symlink",
        icon: iconFor(e.name, dir_, expanded),
        mark: markOf(e, path, s.marks, dirty),
      });
      if (expanded) walk(path, depth + 1);
    }
    if (l.truncated) {
      out.push({
        path: joinPath(dir, "\u0000truncated"),
        name: "",
        depth,
        dir: false,
        expanded: false,
        loading: false,
        symlink: false,
        icon: iconFor("", false, false),
        mark: null,
        truncated: true,
      });
    }
  };
  walk(ROOT, 0);
  return out;
}

/** 行を親子に組んだもの。children はその行より深い、続きの行。 */
export interface TreeNode {
  row: TreeRow;
  children: TreeNode[];
}

/**
 * rows の平らな行を親子に組む（D3）。開いたフォルダの行とその中身を 1 つの要素にまとめ、
 * フォルダの行を中身をスクロールしている間だけ上に固定する（CSS の sticky が親の要素の中で止まる）。
 */
export function nest(rs: TreeRow[]): TreeNode[] {
  const top: TreeNode[] = [];
  const stack: TreeNode[] = [];
  for (const row of rs) {
    while (stack.length > 0 && stack[stack.length - 1].row.depth >= row.depth) {
      stack.pop();
    }
    const node: TreeNode = { row, children: [] };
    (stack.length > 0 ? stack[stack.length - 1].children : top).push(node);
    stack.push(node);
  }
  return top;
}

/** 行で押したキー（と押したこと）でする操作。 */
export type RowAction = "toggle" | "open";

/**
 * 行でキーを押したときの操作。key が undefined なら押した（クリック）とみなす。
 * フォルダは開閉（Enter・Space・閉じていれば →・開いていれば ←）、ファイルは file.open で開く（押す・Enter・Space）。
 * 5000 件より先の印の行は何もしない。
 */
export function rowAction(
  row: Pick<TreeRow, "dir" | "expanded" | "truncated">,
  key?: string,
): RowAction | null {
  if (row.truncated) return null;
  const press = key === undefined || key === "Enter" || key === " ";
  if (!row.dir) return press ? "open" : null;
  if (
    press ||
    (key === "ArrowRight" && !row.expanded) ||
    (key === "ArrowLeft" && row.expanded)
  ) {
    return "toggle";
  }
  return null;
}

/**
 * ファイルの欄でフォーカスしているペインが出しているファイルの、ルートからの相対パス（ツリーの行の path と同じ）。
 * テキストと画像のペインの id はファイルの絶対パス。ルートの外のファイル・差分・プレビュー・ようこそは undefined。
 */
export function currentFile(
  files: Files | null | undefined,
  root: string | undefined,
): string | undefined {
  if (!files || !root) return undefined;
  const pane = files.panes[files.active];
  if (!pane || (pane.kind !== "text" && pane.kind !== "image")) {
    return undefined;
  }
  const base = root.endsWith("/") ? root : `${root}/`;
  if (!pane.id.startsWith(base) || pane.id.length === base.length) {
    return undefined;
  }
  return pane.id.slice(base.length);
}

/** file.open が断られたときに出す文。 */
export function openErrorText(path: string, e: unknown): string {
  const why =
    e instanceof RpcError
      ? ({
          denied: "ワークスペースの外を指しています",
          not_found: "見つかりません",
          invalid_params: "ファイルではありません",
        }[e.codeName] ?? e.message)
      : e instanceof Error
        ? e.message
        : String(e);
  return `${path} を開けませんでした（${why}）`;
}
