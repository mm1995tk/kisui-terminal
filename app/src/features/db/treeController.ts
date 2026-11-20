// DB のタブ（#347）のスキーマの木（#348。サイドバーに出す。#374）の持ち物と操作。画面にも Tauri にも触らない。
// 木の中身（スキーマ → テーブル → 列）は、接続を書いたマシンの kisui serve が返す一覧（db.schema。#346）。
//
// 持ち物の分け方：
// - 一覧・聞いている最中の印・失敗の理由・開けている枝は、タブごとにメモリだけに持つ（開き直したら、もう一度聞く）。
// DB のタブそのものと SQL の実行は controller.ts が持ち、ここはそこから必要な口だけを受け取る（createDbTabs が組み立てる）。
import { T } from "../../i18n/index.ts";
import { createEffect, createSignal, untrack } from "solid-js";

import type {
  DbCatalog,
  DbConnection,
  Requests,
} from "../../infrastructure/rpc/protocol.ts";
import type { DbMethod, Session } from "../sessions/session.ts";
import { dbRefParams, type DbRef } from "../workspaces/model.ts";
import { catalogError, connectionOf, newQueryId } from "./model.ts";
import { initialExpanded, previewSql } from "./tree.ts";

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
  run: (id: string, sql?: string) => Promise<void>;
  /** タブ id が SQL を実行している最中か */
  isRunning: (id: string) => boolean;
  /** 実行中の要求を db.cancel で取り消す */
  cancelQuery: (q: { queryId: string; target: string }) => void;
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
  }

  return {
    /** タブ id の、スキーマの一覧（聞いている最中か・一覧・失敗の理由） */
    catalogOf: (id: string): DbCatalogState => catalogs()[id] ?? {},
    /** タブ id の一覧を聞き直す（開けている枝は残る） */
    reloadCatalog: loadCatalog,
    /** タブ id の木で開けている枝 */
    expandedOf: (id: string): ReadonlySet<string> => new Set(expanded()[id]),
    toggleNode,
    previewTable,
    forget,
  };
}
