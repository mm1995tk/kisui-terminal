// DB のタブ（#347）のスキーマの木（#348。サイドバーに出す。#374）の持ち物と操作。画面にも Tauri にも触らない。
// 木の中身（スキーマ → テーブル → 列）は、接続を書いたマシンの kisui serve が返す一覧（db.schema。#346）。
//
// 持ち物の分け方：
// - 一覧・聞いている最中の印・失敗の理由・開けている枝は、タブごとにメモリだけに持つ（開き直したら、もう一度聞く）。
// - 木の上のドロップダウンで選んだ既定のスキーマ（#378）と、「すべてのスキーマを表示」の印（#398）は、接続ごと
//   （マシン・接続の名前・変種。タブごとではない）に持ち、KeyValueStore（webview の localStorage）に覚える
//   （schemaPrefs.ts）。同じ接続のタブは同じものを使い、アプリを開き直しても残る。
//   既定のスキーマは、SQL の実行（controller.ts）が、実行のたびに db.query の schema に付ける。
// DB のタブそのものと SQL の実行は controller.ts が持ち、ここはそこから必要な口だけを受け取る（createDbTabs が組み立てる）。
import { T } from "../../i18n/index.ts";
import { createEffect, createSignal, untrack } from "solid-js";

import type {
  DbCatalog,
  DbConnection,
  Requests,
} from "../../infrastructure/rpc/protocol.ts";
import type { KeyValueStore } from "../keyValueStore.ts";
import type { DbMethod, Session } from "../sessions/session.ts";
import { dbRefParams, type DbRef } from "../workspaces/model.ts";
import { catalogError, connectionOf, newQueryId } from "./model.ts";
import {
  chosenFor,
  connectionKey,
  loadSchemaPrefs,
  saveSchemaPrefs,
  withSchemaPref,
  type SchemaPrefs,
} from "./schemaPrefs.ts";
import { initialExpanded, keepDefaultSchema, previewSql } from "./tree.ts";

/** タブ 1 つの、サイドバーの木のスキーマの一覧。メモリだけに持つ（開き直したら、もう一度聞く）。 */
export interface DbCatalogState {
  /** 聞いている最中（db.cancel に渡す名前と、送ったマシン）。聞き直している間も、前の一覧は残る */
  loading?: { queryId: string; target: string };
  catalog?: DbCatalog;
  /** 接続の種類（テーブルを見る SQL の引用に使う） */
  kind?: DbConnection["kind"];
  /** 最後に聞いたときの失敗の理由（あれば、前の一覧があってもその横に出す） */
  error?: string;
}

/** createDbTree が返す持ち物。 */
export type DbTree = ReturnType<typeof createDbTree>;

/** 木の持ち物を作る。一覧を聞く・開けている枝・テーブルを選んだときの実行を受け持つ。 */
export function createDbTree(deps: {
  /** 接続ごとの既定のスキーマと「すべてのスキーマを表示」の印の置き場（使えない環境では undefined。そのときは覚えない） */
  store: KeyValueStore | undefined;
  /** タブ id の記録（DbRef） */
  refOf: (id: string) => DbRef | undefined;
  /** ref のマシンの、DB を扱える接続（つながっていない・古い kisui serve なら、理由を投げる） */
  sessionFor: (ref: Pick<DbRef, "target">) => Session;
  /** パスワードを聞く流れつきで、DB の要求を送る（controller.ts の request） */
  request: <M extends DbMethod>(
    ref: DbRef,
    method: M,
    params: Requests[M]["params"],
  ) => Promise<Requests[M]["result"]>;
  /** 今のワークスペースで出している DB のタブ */
  shownDbTab: () => { id: string } | undefined;
  setDraft: (id: string, sql: string) => void;
  /** 木でテーブルを選んだことを、テーブルの構造（#379。structureController.ts）に伝える */
  chooseTable: (id: string, table: { schema: string; table: string }) => void;
  run: (id: string, sql?: string) => Promise<void>;
  /** タブ id が SQL を実行している最中か */
  isRunning: (id: string) => boolean;
  /** 実行中の要求を db.cancel で取り消す */
  cancelQuery: (q: { queryId: string; target: string }) => void;
  /** ref のマシンの kisui serve が、db.query の schema を読むか（capabilities の db-schema。#378） */
  schemaSupported: (ref: Pick<DbRef, "target">) => boolean;
  /** ref のマシンの kisui serve が、db.query の schema を読まない古い版と分かっているか（つながっていて、印が無い） */
  schemaUnsupported: (ref: Pick<DbRef, "target">) => boolean;
  /** できないことを伝える（タイトルと理由） */
  fail: (title: string, text: string) => void;
}) {
  const { refOf, sessionFor, request, shownDbTab } = deps;

  const [catalogs, setCatalogs] = createSignal<
    Readonly<Record<string, DbCatalogState>>
  >({});
  function setCatalog(id: string, f: (c: DbCatalogState) => DbCatalogState) {
    setCatalogs((all) => ({ ...all, [id]: f(all[id] ?? {}) }));
  }
  /** タブ id の木で開けている枝（tree.ts の行の id） */
  const [expanded, setExpanded] = createSignal<
    Readonly<Record<string, readonly string[]>>
  >({});

  /**
   * タブ id の接続のスキーマ・テーブル・列の一覧を聞く（db.schema）。聞いている間は、次を始めない。
   * 前の一覧は、答えが来るまで残す。パスワードの流れは SQL の実行と同じ（request）。
   * テーブルを見る SQL の引用のために、接続の種類も db.connections で知る。
   */
  async function loadCatalog(id: string) {
    const ref = refOf(id);
    if (!ref || untrack(catalogs)[id]?.loading) return;
    const queryId = newQueryId();
    const mine = () => untrack(catalogs)[id]?.loading?.queryId === queryId;
    setCatalog(id, (c) => ({
      ...c,
      loading: { queryId, target: ref.target },
      error: undefined,
    }));
    try {
      // 2 つとも async の中で始める（つながっていないときの同期の throw が、受け手の無い reject を残さないように）
      const [catalog, list] = await Promise.all([
        (async () =>
          request(ref, "db.schema", { ...dbRefParams(ref), queryId }))(),
        (async () => sessionFor(ref).request("db.connections", {}))(),
      ]);
      if (!mine()) return;
      const conn = connectionOf(list.connections, ref);
      if (!conn) throw new Error(T("db.err.noConnection"));
      setCatalog(id, () => ({ catalog, kind: conn.kind }));
      // 一覧から消えたスキーマを既定のまま残さない（#378。読み直す（d r）で抜け出せるように）
      const key = connectionKey(ref);
      const schema = untrack(prefs)[key]?.schema;
      if (schema !== undefined && !keepDefaultSchema(catalog, schema))
        writePrefs(withSchemaPref(untrack(prefs), key, { schema: null }));
      dropUnreadSchema(id, false);
      if (!(id in untrack(expanded)))
        setExpanded((all) => ({ ...all, [id]: initialExpanded(catalog) }));
    } catch (e) {
      if (!mine()) return;
      setCatalog(id, ({ loading: _, ...c }) => ({
        ...c,
        error: catalogError(e),
      }));
    }
  }

  /**
   * 接続ごとに覚えるもの（#398。schemaPrefs.ts）：選んだ既定のスキーマ（#378）と、「すべてのスキーマを表示」の印。
   * 既定のスキーマは、スキーマを書かない名前を、kisui serve が先にそこで探す（PostgreSQL は search_path の先頭、
   * MySQL は USE）。選んでいなければ DB の既定のまま。
   */
  const [prefs, setPrefs] = createSignal<SchemaPrefs>(
    loadSchemaPrefs(deps.store),
  );
  function writePrefs(next: SchemaPrefs) {
    setPrefs(next);
    saveSchemaPrefs(deps.store, next);
  }
  /** タブ id の接続の分（タブが記録に無ければ空）。 */
  function prefOf(id: string) {
    const ref = refOf(id);
    return (ref && prefs()[connectionKey(ref)]) ?? {};
  }
  /**
   * タブ id の接続の既定のスキーマを、ドロップダウンの選択肢 option にする（null は「DB の既定」）。
   * DB の既定のスキーマを選んだときは、何も覚えない（DB の既定のまま。chosenFor）。
   * schema を知らない古い kisui serve は、それを黙って無視して DB の既定のスキーマで実行する（書き込む文も）ので、
   * そのマシンのタブでは選ばせず、理由を伝える。
   */
  function setDefaultSchema(id: string, option: string | null) {
    const ref = refOf(id);
    const catalog = untrack(catalogs)[id]?.catalog;
    if (!ref || !catalog) return;
    const schema = chosenFor(catalog, option);
    if (schema !== null && !deps.schemaSupported(ref)) {
      deps.fail(T("cannot.dbSchema.title"), T("cannot.dbSchema.oldServe"));
      return;
    }
    writePrefs(withSchemaPref(untrack(prefs), connectionKey(ref), { schema }));
  }
  /**
   * タブ id の接続に選んだ既定のスキーマがあるのに、kisui serve がそれを読まない古い版と分かったら、選んだものを捨てて
   * 理由を伝え、true を返す（実行の前に呼ぶ側は、実行しない）。覚えたあとで kisui serve が古い版に替わるとこうなる：
   * そのまま送ると黙って無視され、ドロップダウンが示すスキーマと違う DB の既定のスキーマで実行される（書き込む文も）。
   * beforeRun は、SQL の実行の前に呼んだか（そのときだけ、実行しなかったことも伝える。一覧を読んだあとなら false）。
   */
  function dropUnreadSchema(id: string, beforeRun: boolean): boolean {
    const ref = refOf(id);
    if (!ref) return false;
    const key = connectionKey(ref);
    const schema = untrack(prefs)[key]?.schema;
    if (schema === undefined || !deps.schemaUnsupported(ref)) return false;
    writePrefs(withSchemaPref(untrack(prefs), key, { schema: null }));
    deps.fail(
      T("cannot.dbSchema.title"),
      T(
        beforeRun ? "cannot.dbSchema.droppedNotRun" : "cannot.dbSchema.dropped",
        { schema },
      ),
    );
    return true;
  }
  /** タブ id の接続の「すべてのスキーマを表示」の印を all にする。 */
  function setShowAllSchemas(id: string, all: boolean) {
    const ref = refOf(id);
    if (!ref) return;
    writePrefs(withSchemaPref(untrack(prefs), connectionKey(ref), { all }));
  }

  /** 木の枝 node を開ける・閉じる。 */
  function toggleNode(id: string, node: string, open: boolean) {
    setExpanded((all) => {
      const cur = new Set(all[id] ?? []);
      if (open) cur.add(node);
      else cur.delete(node);
      return { ...all, [id]: [...cur] };
    });
  }

  /**
   * 木でテーブル（ビュー）を選んだ：その中身を見る SQL を入力欄に入れて実行する（入れるのは、何を実行したかを見せ、
   * 手直しして使えるようにするため）。一覧がまだ無い・別の SQL を実行している間は何もしない。
   */
  function previewTable(id: string, schema: string, table: string) {
    const kind = untrack(catalogs)[id]?.kind;
    if (!kind || deps.isRunning(id)) return;
    deps.chooseTable(id, { schema, table });
    const sql = previewSql(kind, schema, table);
    deps.setDraft(id, sql);
    void deps.run(id, sql);
  }

  // DB のタブを出したら、まだ聞いていなければ一覧を聞く（失敗しても繰り返さない。聞き直しは操作で）
  createEffect(() => {
    const t = shownDbTab();
    if (!t) return;
    if (untrack(catalogs)[t.id]) return;
    untrack(() => void loadCatalog(t.id));
  });

  /** タブが記録から無くなった：alive（生きているタブの id を持つもの）にない分の一覧を捨て、聞いている最中のものは取り消す。 */
  function forget(alive: { has(id: string): boolean }) {
    const lists = untrack(catalogs);
    const gone = Object.keys(lists).filter((id) => !alive.has(id));
    for (const id of gone) {
      const q = lists[id]!.loading;
      if (q) deps.cancelQuery(q);
    }
    if (gone.length === 0) return;
    setCatalogs(
      Object.fromEntries(Object.entries(lists).filter(([id]) => alive.has(id))),
    );
    setExpanded((all) =>
      Object.fromEntries(Object.entries(all).filter(([id]) => alive.has(id))),
    );
    // 既定のスキーマと「すべてのスキーマを表示」の印は、接続ごとに覚えるので、タブを閉じても捨てない
  }

  return {
    /** タブ id の、スキーマの一覧（聞いている最中か・一覧・失敗の理由） */
    catalogOf: (id: string): DbCatalogState => catalogs()[id] ?? {},
    /** タブ id の一覧を聞き直す（開けている枝は残る） */
    reloadCatalog: loadCatalog,
    /** タブ id の木で開けている枝 */
    expandedOf: (id: string): ReadonlySet<string> => new Set(expanded()[id]),
    toggleNode,
    /** タブ id の接続で選んだ既定のスキーマ（#378。選んでいなければ undefined） */
    defaultSchemaOf: (id: string): string | undefined => prefOf(id).schema,
    setDefaultSchema,
    dropUnreadSchema,
    /** タブ id の接続の「すべてのスキーマを表示」の印（#398） */
    showAllSchemasOf: (id: string): boolean => prefOf(id).all === true,
    setShowAllSchemas,
    previewTable,
    forget,
  };
}
