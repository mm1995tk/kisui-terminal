// DB のタブ（#347）のスキーマの木（#348。サイドバーに出す。#374）の、画面にも Solid にも依存しない部分（node --test で確かめられる）。
// - 一覧（db.schema の答え）を、開いている枝だけの「見える行」に並べる
// - 木の中のキー（上下で動く・開け閉め・選ぶ）の動き
// - テーブルを選んだときに実行する SQL

import type {
  DbCatalog,
  DbConnection,
} from "../../infrastructure/rpc/protocol.ts";

// ---- 見える行 ----

/** 木の 1 行。schema：スキーマ、table・view：テーブルとビュー、column：列。 */
export interface TreeRow {
  /** 行の名前（開けているかを覚えるのと、動いた先を指すのに使う）。スキーマ・テーブルの名前に使えない字（\u0001）でつなぐ */
  id: string;
  kind: "schema" | "table" | "view" | "column";
  depth: number;
  label: string;
  /** 列の型（列の行だけ） */
  type?: string;
  /** 枝を開け閉めできる（スキーマと、列のあるテーブル） */
  expandable: boolean;
  expanded: boolean;
  /** 1 つ上の行（スキーマは無い） */
  parent?: string;
  schema: string;
  /** テーブル・ビュー・列の行の、テーブルの名前 */
  table?: string;
}

const SEP = "\u0001";
/** スキーマの行の id（TreeRow.id）。 */
export const schemaId = (schema: string) => schema;
/** テーブル・ビューの行の id（TreeRow.id）。 */
export const tableId = (schema: string, table: string) =>
  `${schema}${SEP}${table}`;
/** 列の行の id（TreeRow.id）。 */
export const columnId = (schema: string, table: string, column: string) =>
  `${schema}${SEP}${table}${SEP}${column}`;

/** 一覧から、開いている枝（expanded の id）の下だけを、上から順に並べる。 */
export function visibleRows(
  catalog: DbCatalog,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const s of catalog.schemas) {
    const sid = schemaId(s.name);
    const sOpen = expanded.has(sid);
    rows.push({
      id: sid,
      kind: "schema",
      depth: 0,
      label: s.name,
      expandable: true,
      expanded: sOpen,
      schema: s.name,
    });
    if (!sOpen) continue;
    for (const t of s.tables) {
      const tid = tableId(s.name, t.name);
      const tOpen = expanded.has(tid);
      rows.push({
        id: tid,
        kind: t.kind,
        depth: 1,
        label: t.name,
        expandable: t.columns.length > 0,
        expanded: tOpen && t.columns.length > 0,
        parent: sid,
        schema: s.name,
        table: t.name,
      });
      if (!tOpen) continue;
      for (const c of t.columns)
        rows.push({
          id: columnId(s.name, t.name, c.name),
          kind: "column",
          depth: 2,
          label: c.name,
          type: c.type,
          expandable: false,
          expanded: false,
          parent: tid,
          schema: s.name,
          table: t.name,
        });
    }
  }
  return rows;
}

/** 一覧を初めて出すときに開けておく枝：スキーマが 1 つ（PostgreSQL では普通）なら、それを開ける。 */
export function initialExpanded(catalog: DbCatalog): string[] {
  return catalog.schemas.length === 1
    ? [schemaId(catalog.schemas[0]!.name)]
    : [];
}

// ---- 木の中のキー ----

/** 木のキーで行うこと。 */
export type DbTreeAction =
  "next" | "prev" | "first" | "last" | "expand" | "collapse" | "enter" | "back";

/** 木の中で、キーのあとに何が起きるか。 */
export interface TreeStep {
  /** 選んでいる行を移す先 */
  cursor?: string;
  /** 開ける・閉じる枝 */
  toggle?: { id: string; open: boolean };
  /** テーブルの中身を見る（Enter） */
  preview?: { schema: string; table: string };
  /** キーを SQL の入力欄に戻す（Esc） */
  leave?: boolean;
}

/**
 * 木の中のキー action を、選んでいる行 cursor（無ければ先頭の前）に対して行った結果。
 * - 上下：見える行の中で 1 つ動く（端で止まる）
 * - 右：閉じている枝を開ける。開いていれば、1 つ下の行へ
 * - 左：開いている枝を閉じる。閉じている行・列は、1 つ上の行へ
 * - Enter：スキーマは開け閉め、テーブル・ビューはその中身を見る SQL を実行する、列は何もしない
 */
export function treeStep(
  rows: readonly TreeRow[],
  cursor: string | undefined,
  action: DbTreeAction,
): TreeStep {
  if (action === "back") return { leave: true };
  if (rows.length === 0) return {};
  const i = rows.findIndex((r) => r.id === cursor);
  const cur = i < 0 ? undefined : rows[i];
  const at = (n: number): TreeStep => ({
    cursor: rows[Math.min(rows.length - 1, Math.max(0, n))]!.id,
  });
  switch (action) {
    case "next":
      return at(i + 1);
    case "prev":
      return at(i < 0 ? 0 : i - 1);
    case "first":
      return at(0);
    case "last":
      return at(rows.length - 1);
    case "expand":
      if (!cur) return at(0);
      if (cur.expandable && !cur.expanded)
        return { toggle: { id: cur.id, open: true } };
      if (cur.expanded) return at(i + 1);
      return {};
    case "collapse":
      if (!cur) return {};
      if (cur.expanded) return { toggle: { id: cur.id, open: false } };
      return cur.parent ? { cursor: cur.parent } : {};
    case "enter":
      if (!cur) return {};
      if (cur.kind === "schema")
        return { toggle: { id: cur.id, open: !cur.expanded } };
      if (cur.kind === "table" || cur.kind === "view")
        return { preview: { schema: cur.schema, table: cur.table! } };
      return {};
  }
}

// ---- テーブルを選んだときの SQL ----

/** 一度に見る行数 */
export const PREVIEW_LIMIT = 100;

/** DB の名前の引用（PostgreSQL は "…"、MySQL は `…`。中の引用符は 2 つにする）。 */
export function quoteIdent(kind: DbConnection["kind"], name: string): string {
  const q = kind === "mysql" ? "`" : '"';
  return q + name.split(q).join(q + q) + q;
}

/** テーブル（ビュー）の中身を見る SQL。スキーマも付けるので、DB の今の探す場所に頼らない。 */
export function previewSql(
  kind: DbConnection["kind"],
  schema: string,
  table: string,
): string {
  return `SELECT * FROM ${quoteIdent(kind, schema)}.${quoteIdent(kind, table)} LIMIT ${PREVIEW_LIMIT}`;
}
