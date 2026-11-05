// 足したマシンの記録。サイドバーに出るのは「ローカル」と、ここに記録したマシンだけ。
// 記録の形は、{ target, name? } の配列を JSON にしたもの（target は ssh の行き先。name は付けた名前）。
// 置き場所は webview の localStorage（Tauri のアプリごとに残る。消えたらマシンを足し直す）。
//
// 以前は「前回ワークスペースがあったマシン」だけを記録していた（キー shijimi-editor.lastTargets）。
// 足したマシンの記録がまだ無いときだけ、その記録を引き継ぐ。

import { LOCAL } from "./api.ts";

/** 読み書きの窓口。localStorage と同じ形の最小限。テストで差し替える。 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 設定ファイルで決めたマシンを変えようとしたときの理由。 */
export const FIXED_REASON =
  "設定ファイル（config.toml の [[gui.machines]]）で決めたマシンです。変えるには設定ファイルを直してください";

/** 「ローカル」の表示名。 */
export const LOCAL_LABEL = "ローカル";

/** 足したマシン 1 台。 */
export interface Machine {
  /** ssh の行き先（~/.ssh/config のホスト名など） */
  target: string;
  /** 付けた名前。無ければ target を出す */
  name?: string;
  /** 設定ファイルで決めたマシン。外せず、名前も変えられない（保存もしない） */
  fixed?: boolean;
}

/** localStorage のキー。値は Machine の JSON 配列。 */
export const MACHINES_KEY = "shijimi-editor.machines";
/** 以前の記録のキー（つなぎ先の JSON 配列）。引き継ぐときだけ読む。 */
export const LEGACY_KEY = "shijimi-editor.lastTargets";

/** ssh の引数に渡してよい行き先か（殻の valid_host と同じ決まり）。理由を返す。よければ undefined。 */
export function targetProblem(t: string): string | undefined {
  if (t === "") return "ssh の行き先を入れてください";
  if (t === LOCAL) return "その行き先は使えません";
  if (t.length > 255) return "ssh の行き先が長すぎます";
  if (t.startsWith("-") || t.startsWith("@"))
    return "ssh の行き先は - や @ で始められません";
  if (/[\s\p{Cc}]/u.test(t)) return "ssh の行き先に空白や制御文字は使えません";
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

/** 記録を読む。無い・壊れている・読めないときは空（以前の記録があれば、そこから引き継ぐ）。 */
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

/** 記録を書く。保存できなくても動く（次の起動で消えるだけ）。 */
export function saveMachines(
  store: KeyValueStore | undefined,
  machines: Machine[],
): void {
  try {
    store?.setItem(MACHINES_KEY, JSON.stringify(machines));
  } catch {
    // 保存できなくても動く
  }
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
    return { error: `${labelOf(list, t)} はもう足してあります` };
  const n = cleanName(name);
  if (n !== undefined && nameTaken(list, n, t))
    return { error: `名前 ${n} はほかのマシンで使っています` };
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
    return { error: FIXED_REASON };
  const n = cleanName(name);
  if (n !== undefined && nameTaken(list, n, target))
    return { error: `名前 ${n} はほかのマシンで使っています` };
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

/** マシンを外す。 */
export function removeMachine(list: Machine[], target: string): Machine[] {
  return list.filter((m) => m.target !== target || m.fixed);
}

/** サイドバーに出す名前。付けた名前、無ければ ssh の行き先。「ローカル」はそのまま。 */
export function labelOf(list: Machine[], target: string): string {
  if (target === LOCAL) return LOCAL_LABEL;
  return list.find((m) => m.target === target)?.name ?? target;
}

/** name の名前（付けた名前か行き先）が、target 以外のマシン（と「ローカル」）と重なるか。 */
function nameTaken(list: Machine[], name: string, target: string): boolean {
  if (name === LOCAL_LABEL) return true;
  return list.some((m) => m.target !== target && (m.name ?? m.target) === name);
}

/** 本物の localStorage（使えない環境では undefined）。 */
export function browserStore(): KeyValueStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
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
}

/**
 * サイドバーに出すマシンの一覧。設定ファイルのマシン（fixed）が先で、そのあとに GUI で足したマシン。
 * GUI で足したマシンのうち、設定ファイルと同じ ssh の行き先のものは、設定ファイルのほうを出す。
 * 名前が設定ファイルのマシンと重なる足したマシンは、表示の取り違えを避けるため出さない（記録は消さない）。
 */
export function mergeMachines(
  config: ConfigMachine[],
  saved: Machine[],
): Machine[] {
  const fixed: Machine[] = config.map((c) =>
    c.name
      ? { target: c.ssh, name: c.name, fixed: true }
      : { target: c.ssh, fixed: true },
  );
  const names = new Set(fixed.map((m) => m.name ?? m.target));
  const rest = saved.filter(
    (m) =>
      !fixed.some((f) => f.target === m.target) &&
      !names.has(m.name ?? m.target),
  );
  return [...fixed, ...rest];
}

/**
 * localStorage に書く記録。設定ファイルのマシンは書かない（設定ファイルが持つ）。
 * 設定ファイルと重なって出ていない足したマシンの記録は、設定ファイルから消したときに戻るよう残す。
 */
export function recordToSave(
  next: Machine[],
  saved: Machine[],
  config: ConfigMachine[],
): Machine[] {
  const shown = mergeMachines(config, saved);
  const hidden = saved.filter(
    (m) => !shown.some((s) => s.target === m.target && !s.fixed),
  );
  return [...next.filter((m) => !m.fixed), ...hidden];
}
