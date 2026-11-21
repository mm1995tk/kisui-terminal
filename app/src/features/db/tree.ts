// DB のタブ（#347）のスキーマの木（#348。サイドバーに出す。#374）の、画面にも Solid にも依存しない部分（node --test で確かめられる）。
// - 一覧（db.schema の答え）を、開いている枝だけの「見える行」に並べる（テーブル名で絞り込める。列は木に出さない。列は Structure で見る）。
//   スキーマを 1 つに絞れば（#398。絞る先は schemaPrefs.ts の onlySchema が決める）、そのスキーマのテーブルだけを並べる
// - 木の中のキー（上下で動く・開け閉め・選ぶ・ドロップダウンに移る・すべてのスキーマを出す）の動き
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
  /** 1 つ上の行（スキーマと、スキーマを 1 つに絞ったときのテーブルは無い） */
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
 * only（スキーマの名前。#398）があれば、そのスキーマのテーブルだけを、スキーマの行なしで並べる（開け閉めは無い。
 * filter もその中だけを探す）。一覧に無い名前なら、何も並ばない。
 */
export function visibleRows(
  catalog: DbCatalog,
  expanded: ReadonlySet<string>,
  filter = "",
  only?: string,
): TreeRow[] {
  const q = filter.trim().toLowerCase();
  const rows: TreeRow[] = [];
  for (const s of catalog.schemas) {
    if (only !== undefined && s.name !== only) continue;
    const tables =
      q === ""
        ? s.tables
        : s.tables.filter((t) => t.name.toLowerCase().includes(q));
    if (only !== undefined) {
      for (const t of tables) rows.push(tableRow(s.name, t));
      continue;
    }
    if (q !== "" && tables.length === 0) continue;
    const sid = schemaId(s.name);
    const sOpen = q !== "" || expanded.has(sid);
    rows.push({
      id: sid,
      kind: "schema",
      depth: 0,
      label: s.name,
      // 絞り込み中は開けたまま出すので、開け閉めはできない（h で開けている枝を、見えないまま書き換えない）
      expandable: q === "",
      expanded: sOpen,
      schema: s.name,
    });
    if (!sOpen) continue;
    for (const t of tables) rows.push(tableRow(s.name, t, sid));
  }
  return rows;
}

/** テーブル・ビューの行。parent（スキーマの行の id）があればその 1 段下、無ければ（スキーマを 1 つに絞った木）一番上の段。 */
function tableRow(
  schema: string,
  t: { name: string; kind: "table" | "view" },
  parent?: string,
): TreeRow {
  return {
    id: tableId(schema, t.name),
    kind: t.kind,
    depth: parent === undefined ? 0 : 1,
    label: t.name,
    expandable: false,
    expanded: false,
    ...(parent === undefined ? {} : { parent }),
    schema,
    table: t.name,
  };
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
  | "filter"
  | "schema"
  | "all";

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
  /** キーを、テーブル名で絞り込む入力欄に移す（/） */
  focusFilter?: boolean;
  /** キーを、既定のスキーマを選ぶドロップダウンに移す（s。#398） */
  focusSchema?: boolean;
  /** 「すべてのスキーマを表示」の印を切り替える（a。#398） */
  toggleAll?: boolean;
}

/**
 * 木の中のキー action を、選んでいる行 cursor（無ければ先頭の前）に対して行った結果。
 * - 上下：見える行の中で 1 つ動く（端で止まる）
 * - 右：閉じている枝を開ける。開いていれば、1 つ下の行へ
 * - 左：開いている枝を閉じる。閉じている行は、1 つ上の行へ
 * - /：テーブル名で絞り込む入力欄にキーを移す
 * - s：既定のスキーマを選ぶドロップダウンにキーを移す、a：「すべてのスキーマを表示」の印を切り替える（#398）
 * - Enter：スキーマは開け閉めする、テーブル・ビューはその中身を見る SQL を実行する
 *   （既定のスキーマは、木の上のドロップダウンで選ぶ。スキーマの行では選ばない）
 */
export function treeStep(
  rows: readonly TreeRow[],
  cursor: string | undefined,
  action: DbTreeAction,
): TreeStep {
  if (action === "back") return { leave: true };
  if (action === "filter") return { focusFilter: true };
  if (action === "schema") return { focusSchema: true };
  if (action === "all") return { toggleAll: true };
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
      if (cur.expandable && cur.expanded)
        return { toggle: { id: cur.id, open: false } };
      return cur.parent ? { cursor: cur.parent } : {};
    case "enter":
      if (!cur) return {};
      if (cur.kind === "schema")
        return cur.expandable
          ? { toggle: { id: cur.id, open: !cur.expanded } }
          : {};
      if (cur.kind === "table" || cur.kind === "view")
        return { preview: { schema: cur.schema, table: cur.table! } };
      return {};
  }
}

// ---- 選んだ既定のスキーマ（#378・#398） ----

/**
 * 一覧を読み直したあとも、選んだ既定のスキーマ schema を残すか：一覧にそのスキーマがある、か、一覧が途中で切れていて（truncated）、
 * 無いとは言えない。消えたスキーマを残すと、MySQL では USE が失敗し続ける（接続ごとに覚えるので、アプリを開き直しても続く）。
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
