// DB のタブの窓（リーダーの `a`。#458）に並べる結果のタブの行。窓の画面は ui/main-window/tab-window/DbWindow.tsx。
// 窓は、DB のタブ 1 つの結果のタブ（#404）を左から順に 1 行ずつ並べ、1 つを選んで操作する（出す・閉じる・データと Structure・ページ・書き出す）。
// 画面にも Solid にも依存しない（node --test で確かめられる）。

import { resultSummary } from "./model.ts";
import { resultTabLabel, type DbRun } from "./results.ts";
import type { DbStructureState } from "./structure.ts";

/** 行の状態。running：その文を実行している、cancelled：取り消した、error：失敗した、done：結果がある、none：まだ結果が無い（パスワードを聞いているなど）。 */
export type DbWindowRowState =
  | { kind: "running" }
  | { kind: "cancelled" }
  | { kind: "error"; sqlState?: string }
  | { kind: "done"; summary: string }
  | { kind: "none" };

/** 窓の 1 行（結果のタブ 1 つ）。 */
export interface DbWindowRow {
  /** 結果のタブの id */
  id: string;
  /** 見出し（木で選んだテーブルの名前か、実行した文の先頭。結果のタブの列の見出しと同じ） */
  name: string;
  state: DbWindowRowState;
  /** 結果の場所に出しているタブ */
  shown: boolean;
  /** 仮のタブ（木でテーブルを選んで出したもの。#405） */
  preview: boolean;
  /** 木で選んだテーブル（`スキーマ.テーブル`。結び付いていなければ undefined） */
  table?: string;
  /** 結果の場所に Structure を出している（#379） */
  structure: boolean;
}

/** run の結果のタブを、窓の行にする（左から順）。structureOf は、結果のタブ id の構造（テーブルに結び付いていなければ undefined）。 */
export function dbWindowRows(
  run: DbRun,
  structureOf: (tab: string) => DbStructureState | undefined,
): DbWindowRow[] {
  return run.tabs.map((t) => {
    const s = structureOf(t.id);
    const state: DbWindowRowState =
      run.running?.tab === t.id
        ? { kind: "running" }
        : t.failure?.kind === "cancelled"
          ? { kind: "cancelled" }
          : t.failure?.kind === "error"
            ? {
                kind: "error",
                ...(t.failure.sqlState ? { sqlState: t.failure.sqlState } : {}),
              }
            : t.result
              ? { kind: "done", summary: resultSummary(t.result) }
              : { kind: "none" };
    return {
      id: t.id,
      name: t.label ?? resultTabLabel(t.sql),
      state,
      shown: run.active === t.id,
      preview: run.preview === t.id,
      ...(s ? { table: `${s.table.schema}.${s.table.table}` } : {}),
      structure: s?.view === "structure",
    };
  });
}

/**
 * 選んでいる行。want（窓で選んだ結果のタブ）がまだあればそれ、無くなっていれば（閉じた・上限で閉じた）出しているタブ、
 * それも無ければ先頭。行が無ければ undefined。
 */
export function selectedResult(
  rows: readonly DbWindowRow[],
  want: string | undefined,
): string | undefined {
  if (want !== undefined && rows.some((r) => r.id === want)) return want;
  return (rows.find((r) => r.shown) ?? rows[0])?.id;
}

/** rows の中で、from から step（1 は下、-1 は上）だけ動いた行。端では動かない。 */
export function stepResult(
  rows: readonly DbWindowRow[],
  from: string | undefined,
  step: 1 | -1,
): string | undefined {
  const i = rows.findIndex((r) => r.id === from);
  if (i < 0) return rows[0]?.id;
  return rows[Math.min(rows.length - 1, Math.max(0, i + step))]?.id;
}
