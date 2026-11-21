// DB のタブ（#347）のサイドバーの木の、接続ごとに覚えるもの（#398）の、画面にも Solid にも依存しない部分（node --test で確かめられる）。
// - 覚えるもの：木の上のドロップダウンで選んだ既定のスキーマと、「すべてのスキーマを表示」の印
// - その記録（KeyValueStore。本物は webview の localStorage）の読み書き
// - ドロップダウンに並べる選択肢と、木に出すスキーマを決める
// 持つのは treeController.ts。木の行を並べるのは tree.ts の visibleRows。

import type { DbCatalog } from "../../infrastructure/rpc/protocol.ts";
import type { KeyValueStore } from "../keyValueStore.ts";

// ---- 接続ごとに覚えるもの ----

/** 接続 1 つの分。 */
export interface SchemaPref {
  /** ドロップダウンで選んだ既定のスキーマ（db.query の schema に付ける）。無ければ DB の既定のまま */
  schema?: string;
  /** 「すべてのスキーマを表示」の印。無ければ（false）、既定のスキーマのテーブルだけを木に出す */
  all?: boolean;
}

/** 接続の名前（connectionKey）→ その接続の分。何も覚えていない接続は入れない。 */
export type SchemaPrefs = Readonly<Record<string, SchemaPref>>;

/**
 * 接続を見分ける名前：接続を書いたマシン・接続の名前・環境の変種の 3 つ。変種は別の DB を指すので分ける
 * （同じ名前の接続でも、マシンが違えば別の設定）。タブの id は入れないので、同じ接続のタブは同じものを使う。
 */
export function connectionKey(ref: {
  target: string;
  connection: string;
  variant?: string;
}): string {
  return JSON.stringify([ref.target, ref.connection, ref.variant ?? ""]);
}

/** all の、接続 key の分に change を重ねたもの。覚えるものが無くなった接続は除く。ほかの接続の分は変えない。 */
export function withSchemaPref(
  all: SchemaPrefs,
  key: string,
  change: { schema?: string | null; all?: boolean },
): SchemaPrefs {
  const { [key]: cur = {}, ...rest } = all;
  const schema = change.schema === undefined ? cur.schema : change.schema;
  const showAll = change.all === undefined ? cur.all : change.all;
  const next: SchemaPref = {
    ...(schema ? { schema } : {}),
    ...(showAll ? { all: true } : {}),
  };
  return Object.keys(next).length === 0 ? rest : { ...rest, [key]: next };
}

// ---- 記録 ----

/** localStorage のキー。 */
export const DB_SCHEMA_PREFS_KEY = "kisui-terminal.dbSchemaPrefs";

/** 記録の形の版。形を変えたら上げる（読めない版の記録は捨てる）。 */
const FORMAT_VERSION = 1;

/** 記録を読む。無い・壊れている・版が違うときは空。 */
export function loadSchemaPrefs(store: KeyValueStore | undefined): SchemaPrefs {
  try {
    const raw = store?.getItem(DB_SCHEMA_PREFS_KEY);
    return raw ? parseSchemaPrefs(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** 記録の形を確かめる。形の違うものは捨てる。 */
export function parseSchemaPrefs(v: unknown): SchemaPrefs {
  if (typeof v !== "object" || v === null) return {};
  const o = v as { version?: unknown; connections?: unknown };
  if (o.version !== FORMAT_VERSION) return {};
  if (typeof o.connections !== "object" || o.connections === null) return {};
  let out: SchemaPrefs = {};
  for (const [key, p] of Object.entries(o.connections)) {
    if (typeof p !== "object" || p === null) continue;
    const { schema, all } = p as { schema?: unknown; all?: unknown };
    out = withSchemaPref(out, key, {
      schema: typeof schema === "string" ? schema : null,
      all: all === true,
    });
  }
  return out;
}

/** 記録を書く。書けなくても、今回の分は変わる。 */
export function saveSchemaPrefs(
  store: KeyValueStore | undefined,
  prefs: SchemaPrefs,
): void {
  try {
    store?.setItem(
      DB_SCHEMA_PREFS_KEY,
      JSON.stringify({ version: FORMAT_VERSION, connections: prefs }),
    );
  } catch {
    // 保存できなくても、今回は使える
  }
}

// ---- ドロップダウンと、木に出すスキーマ ----

/** ドロップダウンの中身。null は「DB の既定」（スキーマを選ばない）。 */
export interface SchemaChoices {
  /** 上から並べる選択肢 */
  options: readonly (string | null)[];
  /** 今選ばれている選択肢 */
  selected: string | null;
}

/**
 * ドロップダウンに並べる選択肢と、今選ばれているもの。chosen は、その接続で選んだスキーマ（無ければ undefined）。
 * - 選んでいなければ、DB の既定のスキーマ（catalog.defaultSchema。#396）を示す。
 * - DB の既定のスキーマが一覧に無い（null・一覧に入っていない・それを返さない古い kisui serve）ときだけ、
 *   先頭に「DB の既定」（null）を置く。一覧にあるときは、そのスキーマの行が「DB の既定」を兼ねる（chosenFor）。
 * - 選んだスキーマが一覧に無い（一覧が途中で切れている）ときは、後ろに足す（選んだものを示せるように）。
 */
export function schemaChoices(
  catalog: DbCatalog,
  chosen: string | undefined,
): SchemaChoices {
  const names = catalog.schemas.map((s) => s.name);
  if (chosen !== undefined && !names.includes(chosen)) names.push(chosen);
  const dbDefault = dbDefaultIn(catalog);
  return dbDefault === undefined
    ? { options: [null, ...names], selected: chosen ?? null }
    : { options: names, selected: chosen ?? dbDefault };
}

/** DB の既定のスキーマ。一覧にあるときだけ（無ければ undefined）。 */
function dbDefaultIn(catalog: DbCatalog): string | undefined {
  const d = catalog.defaultSchema;
  return typeof d === "string" && catalog.schemas.some((s) => s.name === d)
    ? d
    : undefined;
}

/**
 * ドロップダウンで option を選んだときに、接続に覚えるスキーマ（null は、覚えない＝DB の既定のまま）。
 * DB の既定のスキーマを選んだときは覚えない：db.query に schema を付けないのと同じ結果になり、
 * DB の側で既定が変わったときに、それに付いていける。
 */
export function chosenFor(
  catalog: DbCatalog,
  option: string | null,
): string | null {
  return option === dbDefaultIn(catalog) ? null : option;
}

/**
 * 木に出すスキーマを 1 つに絞るなら、その名前（すべてのスキーマを出すなら undefined）。
 * showAll（「すべてのスキーマを表示」の印）が無く、ドロップダウンが示すスキーマが一覧にあるときだけ絞る。
 * 示すスキーマが無い（MySQL で DB を指定せずに接続した、DB の既定のスキーマを返さない古い kisui serve）・
 * 一覧に無いときは、木が空にならないように、すべてのスキーマを出す。
 */
export function onlySchema(
  catalog: DbCatalog,
  chosen: string | undefined,
  showAll: boolean,
): string | undefined {
  if (showAll) return undefined;
  const { selected } = schemaChoices(catalog, chosen);
  return selected !== null && catalog.schemas.some((s) => s.name === selected)
    ? selected
    : undefined;
}

/** 「すべてのスキーマを表示」を切り替えられるか：絞る先のスキーマがある（無ければ、いつもすべてを出す）。 */
export function canNarrow(
  catalog: DbCatalog,
  chosen: string | undefined,
): boolean {
  return onlySchema(catalog, chosen, false) !== undefined;
}
