// DB のタブ（#347）の、テーブルの構造（#379）の、画面にも Solid にも依存しない部分（node --test で確かめられる）。
// - 結果の場所の切り替え（データ／Structure）と、選んだテーブル
// - 構造を聞き直すかどうか
// - インデックス・外部キーを、表のセルの文字にする
//
// 結果の場所は、上の切り替えで 2 つに分ける：「データ」は SQL を実行した結果（controller.ts の DbRun）、「Structure」は
// サイドバーの木で選んだテーブルの構造（db.structure）。どちらも結果のタブ（#404。results.ts）ごとに持つ：木でテーブルを選ぶと、
// その中身を見る SQL の結果のタブに、そのテーブルが結び付く。

import type {
  DbStructure,
  DbStructureForeignKey,
  DbStructureIndex,
} from "../../infrastructure/rpc/protocol.ts";

/** 結果の場所に出すもの。data：SQL を実行した結果、structure：選んだテーブルの構造 */
export type DbResultView = "data" | "structure";

/** サイドバーの木で選んだテーブル（ビュー）。名前は db.schema の一覧のまま */
export interface DbTableRef {
  schema: string;
  table: string;
}

/** 結果のタブ 1 つの、テーブルの構造の状態。メモリだけに持つ（開き直したら、もう一度選ぶ）。 */
export interface DbStructureState {
  /** この結果のタブに、木で最後に選んで出したテーブル。これがあるときだけ、結果の場所の上に切り替えを出す */
  table: DbTableRef;
  view: DbResultView;
  /** 聞いている最中（db.cancel に渡す名前と、送ったマシン） */
  loading?: { queryId: string; target: string };
  /** table の構造（聞けたもの） */
  structure?: DbStructure;
  /** 最後に聞いたときの失敗の理由 */
  error?: string;
}

/** 同じテーブルか。 */
export function sameTable(a: DbTableRef, b: DbTableRef): boolean {
  return a.schema === b.schema && a.table === b.table;
}

/**
 * 木でテーブル table を選んだあとの状態。出している側（データ／Structure）は変えない（Structure を見ながら、
 * 木でテーブルを次々に選べるように）。同じテーブルなら、聞いた構造を残す。違うテーブルなら、前の構造は捨てる。
 */
export function selectTable(
  cur: DbStructureState | undefined,
  table: DbTableRef,
): DbStructureState {
  if (cur && sameTable(cur.table, table)) return cur;
  return { table, view: cur?.view ?? "data" };
}

/** 切り替えのもう一方。 */
export function otherView(view: DbResultView): DbResultView {
  return view === "data" ? "structure" : "data";
}

/** 構造を聞きに行くか：Structure を出していて、まだ聞いていない（聞いている最中でも、失敗したあとでもない）。 */
export function needsStructure(s: DbStructureState | undefined): boolean {
  return (
    !!s &&
    s.view === "structure" &&
    !s.structure &&
    !s.loading &&
    s.error === undefined
  );
}

/** 聞き直すために、聞いた構造と失敗を捨てた状態（聞いている最中のものはそのまま）。 */
export function forgetStructure(s: DbStructureState): DbStructureState {
  const { structure: _, error: __, ...rest } = s;
  return rest;
}

// ---- 表のセルの文字 ----

/** 列の並び（"a, b"）。式のキー（MySQL では名前が ""）は "(…)" にする。 */
export function keyColumnsText(columns: readonly string[]): string {
  return columns.map((c) => (c === "" ? "(…)" : c)).join(", ");
}

/** インデックスの印（主キー・一意）。どちらでもなければ ""。 */
export function indexKindText(
  ix: DbStructureIndex,
  words: { primary: string; unique: string },
): string {
  if (ix.primary) return words.primary;
  return ix.unique ? words.unique : "";
}

/** 外部キーが指す先（"schema.table (a, b)"）。同じスキーマなら schema を省く。 */
export function referenceText(
  fk: DbStructureForeignKey,
  schema: string,
): string {
  const table =
    fk.refSchema === schema ? fk.refTable : `${fk.refSchema}.${fk.refTable}`;
  return `${table} (${keyColumnsText(fk.refColumns)})`;
}
