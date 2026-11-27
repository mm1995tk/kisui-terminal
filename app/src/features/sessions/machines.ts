// Dialog のマシンの一覧と、その決まり。サイドバーに出るのは「ローカル」と、設定ファイルの [[gui.machines]] のマシンだけ。
// 一覧を持つのは設定ファイル（config.toml に config.local.toml を重ねたもの）で、Dialog で足す・名前を変える・外すと、
// 殻が config.local.toml を書き換える（config_list.rs。config.toml には書かない）。ここは、書く前の確かめと、一覧の組み立てを持つ。
//
// 前の版は、Window で足したマシンを webview の localStorage（キー shijimi-editor.machines。その前は shijimi-editor.lastTargets）に
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

/** Dialog のマシン 1 台。 */
export interface Machine {
  /** ssh の行き先（~/.ssh/config のホスト名など） */
  target: string;
  /** 付けた名前。無ければ target を出す */
  name?: string;
  /** config.toml にだけ書いたマシン。Dialog からは外せず、名前も変えられない（Dialog は config.toml に書かない） */
  fixed?: boolean;
  /**
   * このマシンのペインが `kisui pane … --machine` で指してよいマシンの名前（設定ファイルの `allow_pane_to`）。
   * 設定ファイルの一覧（fromConfig）だけが付ける。Dialog からは書かない。
   */
  allowPaneTo?: string[];
}

/** 前の版の、Window で足したマシンの記録（localStorage のキー。値は Machine の JSON 配列）。config.local.toml に移すときだけ読む。 */
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
  /** config.local.toml の項目か（両方のファイルにあれば true）。Window が書き換えられるのは true のマシンだけ */
  local?: boolean;
  /** このマシンの新しいターミナルが始まるフォルダ（start_dir。termDefaults.ts）。書いていなければ無い */
  startDir?: string | null;
  /** このマシンの新しいターミナルのシェル（shell。termDefaults.ts）。書いていなければ無い */
  shell?: string | null;
  /** allow_pane_to：このマシンのペインが `--machine` で指してよいマシンの名前（省くと空） */
  allowPaneTo?: string[] | null;
}

/** サイドバーに出すマシンの一覧（設定ファイルの順）。config.toml にだけ書いたマシンは fixed（Dialog から変えない）。 */
export function fromConfig(config: ConfigMachine[]): Machine[] {
  return config.map((c) => {
    const m: Machine = c.name
      ? { target: c.ssh, name: c.name }
      : { target: c.ssh };
    if (c.allowPaneTo?.length) m.allowPaneTo = c.allowPaneTo;
    return c.local ? m : { ...m, fixed: true };
  });
}

/** 殻が config.local.toml に書けなかった理由（config_list.rs の EditError）。 */
export interface MachineEditError {
  kind:
    "exists" | "missing" | "entry" | "file" | "rejected" | "notdir" | "notexec";
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
 * name のマシン。無ければ undefined。名前が local のマシンは、手元の PC と区別できないので選ばない（設定ファイルなら Notice を出す）。
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
 * 名前（付けた名前、無ければ ssh の行き先）が local のマシンの ssh の行き先（`--machine` で選べない。Notice に出す）。
 * Window で足したマシンも、設定ファイルに手で書いたマシンも。
 */
export function localNamed(list: Machine[]): string[] {
  return list.filter((m) => nameOf(m) === LOCAL_MACHINE).map((m) => m.target);
}

/**
 * マシン from（ssh の行き先。手元の PC は LOCAL）のペインの `kisui pane … --machine` を、マシン to に中継してよいか。
 * 手元の PC からは、どのマシンにも中継する（そのマシンには、Window がもう ssh でつないでいる）。自分のマシンを指したものも通す。
 * ssh 先のマシンからは、そのマシンの `allow_pane_to`（設定ファイル）に名前のある先にだけ中継する。書いていなければ、どこにも中継しない。
 * 手元の PC（local）は、設定ファイルでは許せない（書いてあっても数えない）。Window の前の人が時間を決めて許している間（granted。
 * paneGrant.ts）だけ中継する：手元の PC にペインを作らせると、そのマシンは手元の PC でコマンドを動かせるので、
 * 書いたまま忘れられる設定には任せない。
 * 中継を頼む通知は ssh 先の serve が作るので、頼んだ serve の言うことではなく、手元の設定で決める。
 */
export function paneRelayAllowed(
  list: Machine[],
  from: string,
  to: string,
  granted = false,
): boolean {
  if (from === LOCAL || from === to) return true;
  if (to === LOCAL) return granted;
  const allowed = list.find((m) => m.target === from)?.allowPaneTo ?? [];
  return allowed.some(
    (name) => name !== LOCAL_MACHINE && machineTarget(list, name) === to,
  );
}

/**
 * Window に頼むコマンド（`kisui tab` など。#511）が、Machine from（ssh の行き先。手元の PC は LOCAL）の Pane から、Machine to の
 * Tab に届いてよいか。決まりは `--machine` と同じ（paneRelayAllowed）：手元の PC の Pane からは、どの Machine の Tab にも届く。
 * リモートの Machine の Pane からは、その Machine の Tab と、その Machine の `allow_pane_to` に名前のある Machine の Tab にだけ届く。
 * 手元の PC の Tab（Browser tab と Database tab は、どれも手元の PC の Tab として扱う）には、Window の前の人が時間を決めて
 * 許している間（grantedLocal。paneGrant.ts）だけ届く（`allow_pane_to` の `local` は数えない）。`[server] pane_reach` は関係しない
 * （Tab は Window のもので、どの Workspace の Tab にも届く）。
 */
export function windowReachAllowed(
  list: Machine[],
  from: string,
  to: string,
  grantedLocal: boolean,
): boolean {
  return paneRelayAllowed(list, from, to, grantedLocal);
}

/** Machine target（ssh の行き先。手元の PC は LOCAL）の、CLI での名前（`--machine` で選ぶ名前。手元の PC は local）。 */
export function machineCliName(list: Machine[], target: string): string {
  if (target === LOCAL) return LOCAL_MACHINE;
  const m = list.find((x) => x.target === target);
  return m ? nameOf(m) : target;
}

/**
 * `allow_pane_to` に `local` を書いているマシンの名前（効かないので、Notice に出す）。
 */
export function localInAllowPaneTo(list: Machine[]): string[] {
  return list.filter((m) => m.allowPaneTo?.includes(LOCAL_MACHINE)).map(nameOf);
}

/**
 * `allow_pane_to` に書いてあるが、その名前のマシンが無いもの（書き間違い。Notice に出す）。
 * マシンごとに、そのマシンの名前と、無い名前の一覧。
 */
export function unknownAllowPaneTo(
  list: Machine[],
): { machine: string; names: string[] }[] {
  return list.flatMap((m) => {
    const names = (m.allowPaneTo ?? []).filter(
      (n) => machineTarget(list, n) === undefined,
    );
    return names.length > 0 ? [{ machine: nameOf(m), names }] : [];
  });
}
