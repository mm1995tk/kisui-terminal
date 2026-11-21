// DB のタブの結果のタブ（#404）の、画面にも Solid にも依存しない部分（node --test で確かめられる）。
// 結果の場所の上に、結果のタブの列を 1 つ出す。タブ 1 つは、実行した文 1 つとその結果（ページ・並べ替えを含む）を持ち、
// 実行し直しても、ほかのタブの結果は残る。タブは増やせる数に上限があり（MAX_RESULT_TABS）、メモリだけに持つ。
// - ふつうの実行は、出しているタブに上書きする（タブが無ければ足す）。新しいタブに出すのは、そう頼んだ実行だけ。
// - 文を 2 つ以上順に実行したとき（#380）は、1 つ目の文を上の決まりのタブに出し、残りの文はそれぞれ新しいタブに出す。
//   文は、上から 1 つずつ別の db.query で送る（1 つのトランザクションでは包まない）。失敗した・取り消したら、そこで止める。

import type { DbQueryResult } from "../../infrastructure/rpc/protocol.ts";
import type { QueryFailure } from "./model.ts";
import type { DbPage } from "./paging.ts";

/** 結果のタブ 1 つ：実行した文 1 つと、その結果。 */
export interface DbResultTab {
  /** タブの名前（開いている間は変わらない。上書きで実行し直しても同じ。窓の中で重ならない） */
  id: string;
  /** 実行した文（タブの見出しと、ツールチップ） */
  sql: string;
  /** 見出しに文の先頭の代わりに出す字（木で選んだテーブルの名前。#405）。上書きで実行し直すと外れる */
  label?: string;
  /** 文の結果 */
  result?: DbQueryResult;
  /** result がどの SQL のどのページか（ページ送り。#373）。result があれば入っている */
  page?: DbPage;
  /** 文が失敗した・取り消した理由（あれば result の代わりに出す） */
  failure?: Exclude<QueryFailure, { kind: "password" }>;
}

/** DB のタブ 1 つの、メモリだけに持つ状態。 */
export interface DbRun {
  /** 実行している SQL（db.cancel に渡す名前と、送ったマシンと、どの結果のタブの結果になるか）。パスワードを聞いている間も入っている */
  running?: { queryId: string; target: string; tab: string };
  /** 結果のタブ（左から順） */
  tabs: readonly DbResultTab[];
  /** 結果の場所に出しているタブ（tabs が空のときだけ undefined） */
  active?: string;
  /** 仮のタブ（#405。木でテーブルを選ぶと、その中身が出るタブ。1 つだけ。残るタブに変わると undefined） */
  preview?: string;
}

/** まだ実行していない DB のタブの状態。 */
export const EMPTY_RUN: DbRun = { tabs: [] };

/** 結果のタブの数の上限。超えたら、左から（出しているタブ・実行しているタブは除いて）閉じる。 */
export const MAX_RESULT_TABS = 20;

/**
 * 実行の結果を出す先。active：出しているタブに上書きする（無ければ足す）、new：新しいタブを足す、
 * preview：仮のタブに出す（木でテーブルを選んだとき。#405。仮のタブがあれば置き換え、無ければ足して仮のタブにする）。
 */
export type RunInto = "active" | "new" | "preview";

/** 結果の場所に出しているタブ（まだ実行していなければ undefined）。 */
export function activeTab(r: DbRun): DbResultTab | undefined {
  return r.tabs.find((t) => t.id === r.active);
}

/** 結果の場所に出しているタブの文を、今実行しているか。 */
export function activeRunning(r: DbRun): boolean {
  return r.running !== undefined && r.running.tab === r.active;
}

/** 文 1 つを実行し始めるときに決めること。 */
export interface StatementStart {
  sql: string;
  /** 送った db.query の名前と、送ったマシン */
  running: { queryId: string; target: string };
  /** 新しいタブを足すことになったときに付ける名前 */
  newId: string;
  /** 1 つ目の文のタブの見出しに出す字（省くと、文の先頭） */
  label?: string;
  /** 1 つ目の文を出す先（2 つ目からの文は、いつも新しいタブ） */
  into: RunInto;
  /** 2 つ目からの文なら、1 つ前の文を出したタブ（その右隣に足す） */
  prev?: string;
}

/**
 * r で文を実行し始めた状態と、その結果を出すタブ。
 * - 1 つ目の文（prev が無い）で into が active なら、出しているタブを上書きする（前の結果は捨てる。タブが無ければ足す）
 * - 1 つ目の文で into が new なら、出しているタブの右隣に新しいタブを足して、それを出す
 * - 1 つ目の文で into が preview なら、仮のタブ（#405）があれば置き換えて出し、無ければ出しているタブの右隣に足して、
 *   それを仮のタブにする。active で仮のタブを上書きしたときは、仮の印を外す（残るタブに変わる）
 * - 2 つ目からの文は、1 つ前の文のタブの右隣に新しいタブを足す。出しているタブは、実行している文に付いていく。ただし、
 *   順に実行している間に利用者がほかのタブに切り替えていたら、そのまま（1 つ前の文のタブを出しているときだけ付いていく）
 * タブが上限（MAX_RESULT_TABS）を超えたら、左から閉じる（出しているタブ・実行しているタブは残す）。
 */
export function startStatement(
  r: DbRun,
  s: StatementStart,
): { run: DbRun; tab: string } {
  const first = s.prev === undefined;
  const cur = activeTab(r);
  const fresh = (id: string): DbResultTab => ({
    id,
    sql: s.sql,
    ...(first && s.label !== undefined ? { label: s.label } : {}),
  });
  // 1 つ目の文が上書きするタブ：active なら出しているタブ、preview なら仮のタブ。
  // 上書きするタブの仮の印は、preview なら付けたまま、active なら（残るタブに変わるので）外す。
  const over = !first
    ? undefined
    : s.into === "active"
      ? cur
      : s.into === "preview"
        ? r.tabs.find((t) => t.id === r.preview)
        : undefined;
  if (over) {
    const { preview: _, ...rest } = r;
    // preview なら上書き先を仮のタブにする。active なら、上書き先が仮のタブだったときだけ印を外す
    const preview =
      s.into === "preview"
        ? over.id
        : r.preview === over.id
          ? undefined
          : r.preview;
    return {
      run: {
        ...rest,
        tabs: r.tabs.map((t) => (t.id === over.id ? fresh(t.id) : t)),
        active: over.id,
        ...(preview !== undefined ? { preview } : {}),
        running: { ...s.running, tab: over.id },
      },
      tab: over.id,
    };
  }
  const after = first ? r.active : s.prev;
  const at = r.tabs.findIndex((t) => t.id === after);
  const tabs = [...r.tabs];
  tabs.splice(at < 0 ? tabs.length : at + 1, 0, fresh(s.newId));
  const follow = first || cur === undefined || r.active === s.prev;
  const active = follow ? s.newId : r.active;
  const trimmed = trimTabs(tabs, new Set([s.newId, active]));
  const preview = first && s.into === "preview" ? s.newId : r.preview;
  const { preview: _, ...rest } = r;
  return {
    run: {
      ...rest,
      tabs: trimmed,
      active,
      ...(preview !== undefined && trimmed.some((t) => t.id === preview)
        ? { preview }
        : {}),
      running: { ...s.running, tab: s.newId },
    },
    tab: s.newId,
  };
}

/** r のタブ tab を、残るタブにした状態（仮のタブでなければ、そのまま）。並べ替え・ページ送り・ダブルクリックで呼ぶ。 */
export function keepTab(r: DbRun, tab: string): DbRun {
  if (r.preview !== tab) return r;
  const { preview: _, ...rest } = r;
  return rest;
}

/** 文の結果（result と page。失敗なら failure）を出した、タブ t の状態。文と見出しの字は残し、前の結果と失敗は捨てる。 */
export function settleTab(
  t: DbResultTab,
  outcome: Pick<DbResultTab, "result" | "page" | "failure">,
): DbResultTab {
  return {
    id: t.id,
    sql: t.sql,
    ...(t.label !== undefined ? { label: t.label } : {}),
    ...outcome,
  };
}

/** tabs が上限を超えた分を、左から閉じた列（keep のタブは残す）。 */
function trimTabs(
  tabs: readonly DbResultTab[],
  keep: ReadonlySet<string | undefined>,
): readonly DbResultTab[] {
  let over = tabs.length - MAX_RESULT_TABS;
  if (over <= 0) return tabs;
  return tabs.filter((t) => {
    if (over <= 0 || keep.has(t.id)) return true;
    over--;
    return false;
  });
}

/**
 * r のタブ tab の結果を読み直し始めた（ページ送り・並べ替え）状態。前の結果は、新しい結果が来るまで残す。
 * タブが無ければ undefined。
 */
export function restartTab(
  r: DbRun,
  tab: string,
  running: { queryId: string; target: string },
): DbRun | undefined {
  if (!r.tabs.some((t) => t.id === tab)) return undefined;
  return { ...r, running: { ...running, tab } };
}

/** r のタブ tab を f で替えた状態（running は変えない）。タブが無ければ r のまま。 */
export function updateTab(
  r: DbRun,
  tab: string,
  f: (t: DbResultTab) => DbResultTab,
): DbRun {
  if (!r.tabs.some((t) => t.id === tab)) return r;
  return { ...r, tabs: r.tabs.map((t) => (t.id === tab ? f(t) : t)) };
}

/**
 * r のタブ tab を閉じた状態。出しているタブを閉じたら、右隣（無ければ左隣）を出す。実行しているタブを閉じたら、
 * 実行中の印も外す（呼ぶ側が db.cancel を送る）。タブが無ければ r のまま。
 */
export function closeTab(r: DbRun, tab: string): DbRun {
  const at = r.tabs.findIndex((t) => t.id === tab);
  if (at < 0) return r;
  const tabs = r.tabs.filter((t) => t.id !== tab);
  const active =
    r.active === tab ? (tabs[at] ?? tabs[tabs.length - 1])?.id : r.active;
  const { running, active: _, preview, ...rest } = r;
  return {
    ...rest,
    tabs,
    ...(preview !== undefined && preview !== tab ? { preview } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(running && running.tab !== tab ? { running } : {}),
  };
}

/** 出しているタブから step（1 は次、-1 は前）だけ動いた先のタブ。端では動かない（回らない）。タブが無ければ undefined。 */
export function stepTab(r: DbRun, step: 1 | -1): string | undefined {
  const at = r.tabs.findIndex((t) => t.id === r.active);
  if (at < 0) return r.active;
  return r.tabs[Math.min(r.tabs.length - 1, Math.max(0, at + step))]!.id;
}

/** 結果のタブの見出しの字数の上限（これより長い文は切って「…」）。 */
export const RESULT_LABEL_MAX = 24;

/**
 * 結果のタブの見出し：文の先頭の字。前にあるコメント（`--` `#` の行と `/* *\/`）を除き、改行と続く空白を 1 つの空白にして、
 * max 字より長ければ切って「…」を付ける。文がコメントだけなら、詰めた文そのもの。
 */
export function resultTabLabel(sql: string, max = RESULT_LABEL_MAX): string {
  let s = sql.trim();
  for (;;) {
    const m = /^(?:(?:--|#)[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*/.exec(s);
    if (!m || m[0].length === s.length) break;
    s = s.slice(m[0].length);
  }
  const one = s.replace(/\s+/g, " ").trim();
  const chars = [...one];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : one;
}

/** 文 1 つを実行した結果。ok：うまくいった、failed：失敗した・取り消した、gone：タブが閉じた・ほかの実行に替わった。 */
export type StatementOutcome = "ok" | "failed" | "gone";

/**
 * 文 sqls を上から 1 つずつ runOne で実行する（#380）。前の文が終わってから次を送る。
 * - 文が ok でなければ（failed・gone）、そこで止めて、その結果を返す（後の文は送らない）
 * - 後に文が残っていて stopRequested が真なら（取り消しが届く前に文が終わっていた）、"stopped" を返す
 * - 全部 ok なら "done"。最後の文の後では stopRequested を見ない（残りが無いので）
 * runOne の more は、後に文が残っているか。
 */
export async function runInOrder(
  sqls: readonly string[],
  runOne: (
    index: number,
    sql: string,
    more: boolean,
  ) => Promise<StatementOutcome>,
  stopRequested: () => boolean,
): Promise<"done" | "stopped" | "failed" | "gone"> {
  for (let i = 0; i < sqls.length; i++) {
    const more = i < sqls.length - 1;
    const out = await runOne(i, sqls[i]!, more);
    if (out !== "ok") return out;
    if (more && stopRequested()) return "stopped";
  }
  return "done";
}
