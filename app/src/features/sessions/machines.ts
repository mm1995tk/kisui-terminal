// 窓のマシンの一覧と、その決まり。サイドバーに出るのは「ローカル」と、設定ファイルの [[gui.machines]] のマシンだけ。
// 一覧を持つのは設定ファイル（config.toml に config.local.toml を重ねたもの）で、窓で足す・名前を変える・外すと、
// 殻が config.local.toml を書き換える（config_list.rs。config.toml には書かない）。ここは、書く前の確かめと、一覧の組み立てを持つ。
//
// 前の版は、窓で足したマシンを webview の localStorage（キー shijimi-editor.machines。その前は shijimi-editor.lastTargets）に
// 記録していた。その記録は、この版で最初に起動したときに config.local.toml に移す（moveRecords.ts）。ここの loadMachines は、そのときだけ読む。

import type { KeyValueStore } from "../keyValueStore.ts";
import { LOCAL } from "./shell.ts";
import { T, inAllLangs } from "../../i18n/index.ts";

/** config.toml にだけ書いたマシンを変えようとしたときの理由。 */
export const fixedReason = (): string => T("machine.fixedReason");

/** 「ローカル」の表示名。 */
export const localLabel = (): string => T("machine.local");

/** 「ローカル」の名前（どの言語のものも。言語を切り替えたあとで、名前が重ならないようにする）。 */
const localLabels = (): string[] => inAllLangs("machine.local");

/** 窓のマシン 1 台。 */
export interface Machine {
  /** ssh の行き先（~/.ssh/config のホスト名など） */
  target: string;
  /** 付けた名前。無ければ target を出す */
  name?: string;
  /** config.toml にだけ書いたマシン。窓からは外せず、名前も変えられない（窓は config.toml に書かない） */
  fixed?: boolean;
}

/** 前の版の、窓で足したマシンの記録（localStorage のキー。値は Machine の JSON 配列）。config.local.toml に移すときだけ読む。 */
export const MACHINES_KEY = "shijimi-editor.machines";
/** もっと前の版の記録のキー（つなぎ先の JSON 配列）。MACHINES_KEY が無いときだけ、移すために読む。 */
export const LEGACY_KEY = "shijimi-editor.lastTargets";

/** ssh の引数に渡してよい行き先か（殻の valid_host と同じ決まり）。理由を返す。よければ undefined。 */
export function targetProblem(t: string): string | undefined {
  if (t === "") return T("machine.err.empty");
  if (t === LOCAL) return T("machine.err.reserved");
  if (t.length > 255) return T("machine.err.long");
  if (t.startsWith("-") || t.startsWith("@")) return T("machine.err.start");
  if (/[\s\p{Cc}]/u.test(t)) return T("machine.err.space");
  return undefined;
}

function parse(raw: string | null | undefined): Machine[] | undefined {
  if (!raw) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? parseList(v) : undefined;
  } catch {
    return undefined;
  }
}

/** 配列の中から、使える行き先のマシンだけを取り出す（重なりは先のものを残す）。 */
function parseList(v: unknown[]): Machine[] {
  const out: Machine[] = [];
  for (const x of v) {
    if (typeof x !== "object" || x === null) continue;
    const { target, name } = x as { target?: unknown; name?: unknown };
    if (typeof target !== "string" || targetProblem(target) !== undefined)
      continue;
    if (out.some((m) => m.target === target)) continue;
    out.push(
      typeof name === "string" && name !== "" ? { target, name } : { target },
    );
  }
  return out;
}

/** 前の版の記録を読む。無い・壊れている・読めないときは空（MACHINES_KEY が無ければ、LEGACY_KEY の記録を読む）。 */
export function loadMachines(store: KeyValueStore | undefined): Machine[] {
  try {
    const cur = parse(store?.getItem(MACHINES_KEY));
    if (cur) return cur;
    const old = store?.getItem(LEGACY_KEY);
    if (old) {
      const v: unknown = JSON.parse(old);
      if (Array.isArray(v)) {
        return parseList(
          v
            .filter((t): t is string => typeof t === "string")
            .map((target) => ({ target })),
        );
      }
    }
  } catch {
    // 読めなければ空
  }
  return [];
}

/** 名前の前後の空白を除く。空なら名前なし。 */
function cleanName(name: string | undefined): string | undefined {
  const n = name?.trim();
  return n ? n : undefined;
}

/**
 * マシンを足す。行き先の前後の空白は除く。使えない行き先・足してある行き先では、理由を返す。
 * 名前は表示の取り違えを避けるため、足してある別のマシンと同じにはできない。
 */
export function addMachine(
  list: Machine[],
  target: string,
  name?: string,
): { machines: Machine[] } | { error: string } {
  const t = target.trim();
  const problem = targetProblem(t);
  if (problem) return { error: problem };
  if (list.some((m) => m.target === t))
    return { error: T("machine.err.added", { label: labelOf(list, t) }) };
  const n = cleanName(name);
  if ((n ?? t) === LOCAL_MACHINE) return { error: T("machine.err.localName") };
  if (n !== undefined && nameTaken(list, n, t))
    return { error: T("machine.err.nameTaken", { name: n }) };
  return {
    machines: [
      ...list,
      n === undefined ? { target: t } : { target: t, name: n },
    ],
  };
}

/** 名前を変える。空にすると行き先の名前に戻る。使えない名前では、理由を返す。 */
export function renameMachine(
  list: Machine[],
  target: string,
  name: string,
): { machines: Machine[] } | { error: string } {
  if (list.some((m) => m.target === target && m.fixed))
    return { error: fixedReason() };
  const n = cleanName(name);
  if ((n ?? target) === LOCAL_MACHINE)
    return { error: T("machine.err.localName") };
  if (n !== undefined && nameTaken(list, n, target))
    return { error: T("machine.err.nameTaken", { name: n }) };
  return {
    machines: list.map((m) =>
      m.target !== target
        ? m
        : n === undefined
          ? { target }
          : { target, name: n },
    ),
  };
}

/** サイドバーに出す名前。付けた名前、無ければ ssh の行き先。「ローカル」はそのまま。 */
export function labelOf(list: Machine[], target: string): string {
  if (target === LOCAL) return localLabel();
  return list.find((m) => m.target === target)?.name ?? target;
}

/** name の名前（付けた名前か行き先）が、target 以外のマシン（と「ローカル」）と重なるか。 */
function nameTaken(list: Machine[], name: string, target: string): boolean {
  if (localLabels().includes(name)) return true;
  return list.some((m) => m.target !== target && (m.name ?? m.target) === name);
}

/** 候補（~/.ssh/config のホスト）を入力で絞る（大文字小文字を区別しない）。 */
export function filterCandidates(
  candidates: string[],
  query: string,
): string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return candidates;
  return candidates.filter((c) => c.toLowerCase().includes(q));
}

/** 設定ファイルに書いたマシン 1 台（Tauri の側が読んで渡す。config.rs の ConfigMachine と同じ形）。 */
export interface ConfigMachine {
  ssh: string;
  name?: string | null;
  /** config.local.toml の項目か（両方のファイルにあれば true）。窓が書き換えられるのは true のマシンだけ */
  local?: boolean;
  /** このマシンの新しいターミナルが始まるフォルダ（start_dir。termDefaults.ts）。書いていなければ無い */
  startDir?: string | null;
  /** このマシンの新しいターミナルのシェル（shell。termDefaults.ts）。書いていなければ無い */
  shell?: string | null;
}

/** サイドバーに出すマシンの一覧（設定ファイルの順）。config.toml にだけ書いたマシンは fixed（窓から変えない）。 */
export function fromConfig(config: ConfigMachine[]): Machine[] {
  return config.map((c) => {
    const m: Machine = c.name
      ? { target: c.ssh, name: c.name }
      : { target: c.ssh };
    return c.local ? m : { ...m, fixed: true };
  });
}

/** 殻が config.local.toml に書けなかった理由（config_list.rs の EditError）。 */
export interface MachineEditError {
  kind:
    | "exists"
    | "missing"
    | "entry"
    | "file"
    | "rejected"
    | "notdir"
    | "notexec";
  /**
   * 足す・変える・外す相手の ssh の行き先（exists・missing）、手元のマシンに書こうとした start_dir（notdir）・shell（notexec）、
   * 設定の間違いと同じ形の説明（ほか）
   */
  detail: string;
}

/** 殻から来た、書けなかった理由（MachineEditError の形）か。 */
export function isMachineEditError(e: unknown): e is MachineEditError {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    typeof e.kind === "string" &&
    "detail" in e
  );
}

/** 殻が config.local.toml に書けなかった理由を、画面に出す 1 文にする（殻から来たもの以外も受ける）。 */
export function machineEditError(e: unknown): string {
  if (isMachineEditError(e)) {
    const { kind, detail } = e;
    if (kind === "exists") return T("machine.edit.exists", { ssh: detail });
    if (kind === "missing") return T("machine.edit.missing", { ssh: detail });
    if (kind === "notdir")
      return T("termSettings.err.notDir", { path: detail });
    if (kind === "notexec")
      return T("termSettings.err.notExec", { path: detail });
    return T("machine.edit.failed", { error: String(detail) });
  }
  return T("machine.edit.failed", { error: String(e) });
}

/** `kisui pane … --machine` で、GUI の動く手元の PC を指す名前（予約語。#344）。 */
export const LOCAL_MACHINE = "local";

/** マシンの名前（付けた名前、無ければ ssh の行き先）。`--machine` で選ぶ名前。 */
const nameOf = (m: { target: string; name?: string }): string =>
  m.name ?? m.target;

/**
 * `kisui pane … --machine name` のマシンの行き先。local は手元の PC（LOCAL）。ほかは、名前（付けた名前、無ければ ssh の行き先）が
 * name のマシン。無ければ undefined。名前が local のマシンは、手元の PC と区別できないので選ばない（設定ファイルならお知らせを出す）。
 */
export function machineTarget(
  list: Machine[],
  name: string,
): string | undefined {
  if (name === LOCAL_MACHINE) return LOCAL;
  return list.find((m) => nameOf(m) === name)?.target;
}

/** `--machine` で選べるマシンの名前（local が先）。 */
export function machineNames(list: Machine[]): string[] {
  return [
    LOCAL_MACHINE,
    ...list.map(nameOf).filter((n) => n !== LOCAL_MACHINE),
  ];
}

/**
 * 名前（付けた名前、無ければ ssh の行き先）が local のマシンの ssh の行き先（`--machine` で選べない。お知らせに出す）。
 * 窓で足したマシンも、設定ファイルに手で書いたマシンも。
 */
export function localNamed(list: Machine[]): string[] {
  return list.filter((m) => nameOf(m) === LOCAL_MACHINE).map((m) => m.target);
}
