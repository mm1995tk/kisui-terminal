// DB のタブ（#347）のスキーマの木（#348。サイドバーに出す。#374）の、画面にも Solid にも依存しない部分（node --test で確かめられる）。
// - 一覧（db.schema の答え）を、開いている枝だけの「見える行」に並べる（テーブル名で絞り込める。列は木に出さない。列は Structure で見る）
// - 木の中のキー（上下で動く・開け閉め・選ぶ・既定のスキーマにする）の動き
// - テーブルを選んだときに実行する SQL

import type {
  DbCatalog,
  DbConnection,
} from "../../infrastructure/rpc/protocol.ts";

// ---- 見える行 ----

/** 木の 1 行。schema：スキーマ、table・view：テーブルとビュー。 */
export interface TreeRow {
  /** 行の名前（開けているかを覚えるのと、動いた先を指すのに使う）。スキーマ・テーブルの名前に使えない字（\u0001）でつなぐ */
  id: string;
  kind: "schema" | "table" | "view";
  depth: number;
  label: string;
  /** 枝を開け閉めできる（スキーマだけ） */
  expandable: boolean;
  expanded: boolean;
  /** 1 つ上の行（スキーマは無い） */
  parent?: string;
  schema: string;
  /** テーブル・ビューの行の、テーブルの名前 */
  table?: string;
}

const SEP = "\u0001";
/** スキーマの行の id（TreeRow.id）。 */
export const schemaId = (schema: string) => schema;
/** テーブル・ビューの行の id（TreeRow.id）。 */
export const tableId = (schema: string, table: string) =>
  `${schema}${SEP}${table}`;

/**
 * 一覧から、開いている枝（expanded の id）の下だけを、上から順に並べる。
 * filter（テーブル名で絞る字。空白だけなら絞らない）があれば、名前にそれを含む（大文字と小文字を区別しない）テーブルだけを残し、
 * 合うテーブルのあるスキーマは開いた状態で出す（合うものが無いスキーマは出さない）。開けている枝（expanded）は変えないので、
 * filter を空に戻せば、絞る前の木に戻る。
 */
export function visibleRows(
  catalog: DbCatalog,
  expanded: ReadonlySet<string>,
  filter = "",
): TreeRow[] {
  const q = filter.trim().toLowerCase();
  const rows: TreeRow[] = [];
  for (const s of catalog.schemas) {
    const tables =
      q === ""
        ? s.tables
        : s.tables.filter((t) => t.name.toLowerCase().includes(q));
    if (q !== "" && tables.length === 0) continue;
    const sid = schemaId(s.name);
    const sOpen = q !== "" || expanded.has(sid);
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
    for (const t of tables)
      rows.push({
        id: tableId(s.name, t.name),
        kind: t.kind,
        depth: 1,
        label: t.name,
        expandable: false,
        expanded: false,
        parent: sid,
        schema: s.name,
        table: t.name,
      });
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
  | "next"
  | "prev"
  | "first"
  | "last"
  | "expand"
  | "collapse"
  | "enter"
  | "back"
  | "filter";

/** 木の中で、キーのあとに何が起きるか。 */
export interface TreeStep {
  /** 選んでいる行を移す先 */
  cursor?: string;
  /** 開ける・閉じる枝 */
  toggle?: { id: string; open: boolean };
  /** テーブルの中身を見る（Enter） */
  preview?: { schema: string; table: string };
  /** タブの既定のスキーマ（#378）にする（Enter）。null は、既定のスキーマをやめる（DB の既定に戻す） */
  setDefaultSchema?: string | null;
  /** キーを SQL の入力欄に戻す（Esc） */
  leave?: boolean;
  /** キーを、テーブル名で絞り込む入力欄に移す（/） */
  focusFilter?: boolean;
}

/**
 * 木の中のキー action を、選んでいる行 cursor（無ければ先頭の前）に対して行った結果。
 * defaultSchema は、タブの今の既定のスキーマ（#378。選んでいなければ undefined）。
 * - 上下：見える行の中で 1 つ動く（端で止まる）
 * - 右：閉じている枝を開ける。開いていれば、1 つ下の行へ
 * - 左：開いている枝を閉じる。閉じている行は、1 つ上の行へ
 * - /：テーブル名で絞り込む入力欄にキーを移す
 * - Enter：スキーマはタブの既定のスキーマにする（閉じていれば開ける。もう既定なら、既定をやめる）、
 *   テーブル・ビューはその中身を見る SQL を実行する
 */
export function treeStep(
  rows: readonly TreeRow[],
  cursor: string | undefined,
  action: DbTreeAction,
  defaultSchema?: string,
): TreeStep {
  if (action === "back") return { leave: true };
  if (action === "filter") return { focusFilter: true };
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
      if (cur.kind === "schema") {
        if (cur.schema === defaultSchema) return { setDefaultSchema: null };
        return {
          setDefaultSchema: cur.schema,
          ...(cur.expanded ? {} : { toggle: { id: cur.id, open: true } }),
        };
      }
      if (cur.kind === "table" || cur.kind === "view")
        return { preview: { schema: cur.schema, table: cur.table! } };
      return {};
  }
}

// ---- タブの既定のスキーマ（#378） ----

/** タブ id → 既定のスキーマ all の、タブ id の分だけを schema にしたもの（null なら除く）。ほかのタブの分は変えない。 */
export function withDefaultSchema(
  all: Readonly<Record<string, string>>,
  id: string,
  schema: string | null,
): Readonly<Record<string, string>> {
  const { [id]: _, ...rest } = all;
  return schema === null ? rest : { ...rest, [id]: schema };
}

/**
 * 一覧を読み直したあとも、既定のスキーマ schema を残すか：一覧にそのスキーマがある、か、一覧が途中で切れていて（truncated）、
 * 無いとは言えない。消えたスキーマを残すと、MySQL では USE が失敗し続け、木にも出ないので選び直してやめることもできない。
 */
export function keepDefaultSchema(catalog: DbCatalog, schema: string): boolean {
  return catalog.truncated || catalog.schemas.some((s) => s.name === schema);
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
