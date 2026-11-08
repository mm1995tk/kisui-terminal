// 差分モードの CHANGES の一覧（サイドバーのファイルエクスプローラの下）の行を組み立てる。
// 元は shj が知らせる primaryShj.diff（docs/protocol.md の PrimaryDiff）。

import { RpcError } from "../rpc/message.ts";
import type { DiffFile, PrimaryDiff } from "../rpc/protocol.ts";

/** 一覧の行の印：変更 M・追加 A・削除 D・名前変更 R・バイナリ B */
export type ChangeLetter = "M" | "A" | "D" | "R" | "B";

/** CHANGES の一覧の 1 行（1 ファイル） */
export interface ChangeRow {
  /** shj.diff に送る path（shj が知らせた絶対パス） */
  path: string;
  /** ファイル名 */
  name: string;
  /** 名前の前のフォルダ（root の中なら root からの相対、外なら絶対パス）。無ければ "" */
  dir: string;
  letter: ChangeLetter;
  /** 読み上げの言葉 */
  label: string;
  added: number;
  deleted: number;
  /** shj が今差分を出しているファイル */
  selected: boolean;
}

const letters = new Map<string, [ChangeLetter, string]>([
  ["added", ["A", "追加"]],
  ["deleted", ["D", "削除"]],
  ["renamed", ["R", "名前変更"]],
  ["binary", ["B", "バイナリ"]],
]);

/** 状態の言葉を印にする。知らない言葉・無い言葉は「変更」。 */
export function letterOf(status: string | undefined): [ChangeLetter, string] {
  return (status ? letters.get(status) : undefined) ?? ["M", "変更"];
}

/** 一覧の行。root は ワークスペースのルート（その中のファイルは相対パスで出す）。 */
export function changeRows(
  diff: PrimaryDiff,
  root: string | undefined,
): ChangeRow[] {
  const base = root ? (root.endsWith("/") ? root : `${root}/`) : undefined;
  return diff.files.map((f: DiffFile) => {
    const shown =
      base && f.path.startsWith(base) ? f.path.slice(base.length) : f.path;
    const i = shown.lastIndexOf("/");
    const [letter, label] = letterOf(f.status);
    return {
      path: f.path,
      name: i < 0 ? shown : shown.slice(i + 1),
      dir: i < 0 ? "" : shown.slice(0, i),
      letter,
      label,
      added: f.added ?? 0,
      deleted: f.deleted ?? 0,
      selected: f.path === diff.selected,
    };
  });
}

/** shj.diff が断られたときに出す文。 */
export function changeErrorText(path: string, e: unknown): string {
  const why =
    e instanceof RpcError
      ? e.codeName === "not_found"
        ? "一覧にありません（変更が済んだか、差分モードを閉じました）"
        : e.message
      : e instanceof Error
        ? e.message
        : String(e);
  return `${path} の差分を出せませんでした（${why}）`;
}

/** CHANGES の木の 1 行：フォルダか、変更のあるファイル。 */
export interface ChangeEntry {
  /** フォルダは dir の途中までのパス（閉じた印の鍵。まとめた行は一番深いフォルダのパス）、ファイルは ChangeRow.path */
  key: string;
  kind: "dir" | "file";
  /** 出す名前（フォルダは 1 階層ぶん。まとめた行は "app/src" のようにつなぐ） */
  name: string;
  /** 一番上が 0 */
  depth: number;
  /** フォルダが開いているか（ファイルは false） */
  expanded: boolean;
  /** フォルダの中にある変更のあるファイルの数（ファイルは 0） */
  count: number;
  /** 閉じたフォルダで、shj が差分を出しているファイルがその中にある */
  holdsSelected: boolean;
  /** ファイルの行（フォルダは無い） */
  row?: ChangeRow;
  /** 親のフォルダの key（一番上なら undefined） */
  parent?: string;
}

/** 木の枝。children は shj が知らせたファイルの順に、フォルダはそのフォルダのファイルが最初に出た所に置く。 */
interface Branch {
  key: string;
  name: string;
  children: (Branch | ChangeRow)[];
}

/** フォルダ名の列。dir の "" は []、絶対パスは先頭の "/" を落とす（鍵は先頭に "/" を戻す）。 */
function dirChain(dir: string): { key: string; name: string }[] {
  if (dir === "") return [];
  const abs = dir.startsWith("/");
  const parts = dir.split("/").filter((p) => p !== "");
  return parts.map((name, i) => ({
    key: (abs ? "/" : "") + parts.slice(0, i + 1).join("/"),
    name,
  }));
}

const isBranch = (c: Branch | ChangeRow): c is Branch => "children" in c;

/** 行を木にする（TUI の changeTree と同じく、ファイルが無く子のフォルダが 1 つだけのフォルダは 1 行にまとめる）。 */
function buildBranches(rows: readonly ChangeRow[]): (Branch | ChangeRow)[] {
  const top: (Branch | ChangeRow)[] = [];
  const byKey = new Map<string, Branch>();
  for (const r of rows) {
    let into = top;
    for (const d of dirChain(r.dir)) {
      let b = byKey.get(d.key);
      if (!b) {
        b = { key: d.key, name: d.name, children: [] };
        byKey.set(d.key, b);
        into.push(b);
      }
      into = b.children;
    }
    into.push(r);
  }
  const merge = (c: Branch | ChangeRow): Branch | ChangeRow => {
    if (!isBranch(c)) return c;
    let b = c;
    while (b.children.length === 1 && isBranch(b.children[0])) {
      const only = b.children[0];
      b = {
        key: only.key,
        name: `${b.name}/${only.name}`,
        children: only.children,
      };
    }
    return { ...b, children: b.children.map(merge) };
  };
  return top.map(merge);
}

function countFiles(b: Branch): number {
  return b.children.reduce((n, c) => n + (isBranch(c) ? countFiles(c) : 1), 0);
}

/**
 * 変更のあるファイルの行を、TUI の CHANGES と同じフォルダの木にして、見えている行を上から順に返す。
 * 順番は shj が知らせたファイルの順。closed は閉じているフォルダの鍵。閉じたフォルダの行は出し、中身は出さない。
 */
export function changeTree(
  rows: readonly ChangeRow[],
  closed: ReadonlySet<string>,
): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  const holds = (b: Branch): boolean =>
    b.children.some((c) => (isBranch(c) ? holds(c) : c.selected));
  const walk = (
    cs: (Branch | ChangeRow)[],
    depth: number,
    parent: string | undefined,
  ) => {
    for (const c of cs) {
      if (!isBranch(c)) {
        out.push({
          key: c.path,
          kind: "file",
          name: c.name,
          depth,
          expanded: false,
          count: 0,
          holdsSelected: false,
          row: c,
          parent,
        });
        continue;
      }
      const expanded = !closed.has(c.key);
      out.push({
        key: c.key,
        kind: "dir",
        name: c.name,
        depth,
        expanded,
        count: countFiles(c),
        holdsSelected: !expanded && holds(c),
        parent,
      });
      if (expanded) walk(c.children, depth + 1, c.key);
    }
  };
  walk(buildBranches(rows), 0, undefined);
  return out;
}
