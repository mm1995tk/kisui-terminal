// DB のタブ（#347）の、テーブルの構造（#379）の持ち物と操作。画面にも Tauri にも触らない。
// 構造は、接続を書いたマシンの kisui serve が返す（db.structure）。
//
// 持ち物の分け方：
// - 木で選んだテーブル・結果の場所に出している側（データ／Structure）・聞いた構造は、タブごとにメモリだけに持つ。
// - SQL を実行した結果（データの側）は controller.ts の DbRun が持ち、ここは触らない（文ごとの結果に変わっても（#380）、
//   ここは変わらないように）。
import { T } from "../../i18n/index.ts";
import { createEffect, createSignal, untrack } from "solid-js";

import type { Requests } from "../../infrastructure/rpc/protocol.ts";
import type { DbMethod } from "../sessions/session.ts";
import { dbRefParams, type DbRef } from "../workspaces/model.ts";
import { catalogError, newQueryId } from "./model.ts";
import {
  forgetStructure,
  needsStructure,
  otherView,
  sameTable,
  selectTable,
  type DbResultView,
  type DbStructureState,
  type DbTableRef,
} from "./structure.ts";

/** createDbStructure が返す持ち物。 */
export type DbStructures = ReturnType<typeof createDbStructure>;

/** テーブルの構造の持ち物を作る。選んだテーブル・出している側・構造を聞くを受け持つ。 */
export function createDbStructure(deps: {
  /** タブ id の記録（DbRef） */
  refOf: (id: string) => DbRef | undefined;
  /** パスワードを聞く流れつきで、DB の要求を送る（controller.ts の request） */
  request: <M extends DbMethod>(
    ref: DbRef,
    method: M,
    params: Requests[M]["params"],
  ) => Promise<Requests[M]["result"]>;
  /** ref のマシンの kisui serve が、db.structure を受けない古い版か（つながっていて、capabilities に db-structure が無い） */
  oldServe: (ref: Pick<DbRef, "target">) => boolean;
  /** 実行中の要求を db.cancel で取り消す */
  cancelQuery: (q: { queryId: string; target: string }) => void;
}) {
  const { refOf, request } = deps;
  const [states, setStates] = createSignal<
    Readonly<Record<string, DbStructureState>>
  >({});
  function setState(
    id: string,
    f: (s: DbStructureState) => DbStructureState | undefined,
  ) {
    setStates((all) => {
      const cur = all[id];
      if (!cur) return all;
      const next = f(cur);
      if (next === cur) return all;
      const { [id]: _, ...rest } = all;
      return next ? { ...rest, [id]: next } : rest;
    });
  }

  /** タブ id の、選んだテーブルの構造を聞く（db.structure）。古い kisui serve なら、聞かずに理由を残す。 */
  async function load(id: string) {
    const ref = refOf(id);
    const s = untrack(states)[id];
    if (!ref || !s || s.loading) return;
    const table = s.table;
    if (deps.oldServe(ref)) {
      setState(id, (c) => ({ ...c, error: T("db.structure.oldServe") }));
      return;
    }
    const queryId = newQueryId();
    const mine = () => {
      const c = untrack(states)[id];
      return c?.loading?.queryId === queryId && sameTable(c.table, table);
    };
    setState(id, (c) => ({
      ...forgetStructure(c),
      loading: { queryId, target: ref.target },
    }));
    try {
      const structure = await request(ref, "db.structure", {
        ...dbRefParams(ref),
        queryId,
        schema: table.schema,
        table: table.table,
      });
      if (!mine()) return;
      setState(id, ({ loading: _, ...c }) => ({ ...c, structure }));
    } catch (e) {
      if (!mine()) return;
      setState(id, ({ loading: _, ...c }) => ({
        ...c,
        error: catalogError(e),
      }));
    }
  }

  // Structure を出していて、まだ聞いていなければ聞く（失敗しても繰り返さない。聞き直しは d r で）
  createEffect(() => {
    const all = states();
    for (const id of Object.keys(all))
      if (needsStructure(all[id])) untrack(() => void load(id));
  });

  /** 木でテーブルを選んだ（その中身を見る SQL も実行される。tree の previewTable）。違うテーブルなら、聞いている最中のものはやめる。 */
  function choose(id: string, table: DbTableRef) {
    const cur = untrack(states)[id];
    if (cur?.loading && !sameTable(cur.table, table))
      deps.cancelQuery(cur.loading);
    setStates((all) => ({ ...all, [id]: selectTable(all[id], table) }));
  }

  /**
   * タブ id の結果の場所に view を出す（省くと、今と違う方）。テーブルを選んでいなければ（切り替えが無い）false。
   */
  function showView(id: string, view?: DbResultView): boolean {
    const cur = untrack(states)[id];
    if (!cur) return false;
    const next = view ?? otherView(cur.view);
    setState(id, (c) => (c.view === next ? c : { ...c, view: next }));
    return true;
  }

  /** タブ id の構造を聞き直す（Structure を出していれば、すぐに聞く）。 */
  function reload(id: string) {
    const cur = untrack(states)[id];
    if (!cur || cur.loading) return;
    setState(id, forgetStructure);
  }

  /** タブが記録から無くなった：alive にない分を捨て、聞いている最中のものは取り消す。 */
  function forget(alive: { has(id: string): boolean }) {
    const all = untrack(states);
    const gone = Object.keys(all).filter((id) => !alive.has(id));
    if (gone.length === 0) return;
    for (const id of gone) {
      const q = all[id]!.loading;
      if (q) deps.cancelQuery(q);
    }
    setStates(
      Object.fromEntries(Object.entries(all).filter(([id]) => alive.has(id))),
    );
  }

  return {
    /** タブ id の、選んだテーブルと構造（テーブルを選んでいなければ undefined） */
    structureOf: (id: string): DbStructureState | undefined => states()[id],
    chooseTable: choose,
    showView,
    reloadStructure: reload,
    forgetStructures: forget,
  };
}
