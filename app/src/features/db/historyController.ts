// DB のタブの、接続ごとのクエリの履歴の呼び出し（#349）の操作。履歴は kisui serve のマシンに、接続ごとに残っている
// （db.history。#346）。Dialog を開けるたびに、そのタブの接続の履歴だけを聞く。選んだ SQL は入力欄に入れるだけで、実行しない。
// DB にはつながない要求なので、パスワードは聞かない。画面にも Tauri にも触らない。
import { createSignal, untrack } from "solid-js";

import type { DbHistoryEntry } from "../../infrastructure/rpc/protocol.ts";
import type { Session } from "../sessions/session.ts";
import { dbRefLabel, dbRefParams, type DbRef } from "../workspaces/model.ts";
import { catalogError } from "./model.ts";

/** 履歴の Dialog に出すもの。entries は聞き終えるまで無い。 */
export interface DbHistoryAsk {
  /** 履歴を呼び出すタブ */
  tab: string;
  /** 接続の名前（Dialog の見出しに出す。環境の変種があれば `接続 (変種)`） */
  connection: string;
  /** 新しい順 */
  entries?: DbHistoryEntry[];
  /** 聞けなかった理由 */
  error?: string;
}

/** 履歴の持ち物を作る。Dialog を開ける（聞く）・SQL を選んで入力欄に入れる・やめるを受け持つ。 */
export function createDbHistory(deps: {
  refOf: (id: string) => DbRef | undefined;
  /** ref のマシンの、DB を扱える接続（つながっていない・古い kisui serve なら、理由を投げる） */
  sessionFor: (ref: Pick<DbRef, "target">) => Session;
  setDraft: (id: string, sql: string) => void;
  /** 今使っているペイン（DB のタブを出していれば SQL の入力欄）にキーを向ける */
  focusTerminal: () => void;
}) {
  const [ask, setAsk] = createSignal<DbHistoryAsk | null>(null);
  let gen = 0;

  /** タブ id の接続の履歴の Dialog を出す。履歴は開くたびに聞く（Dialog には、聞き終えるまで「読み込み中」が出る）。 */
  async function openHistory(id: string): Promise<void> {
    const ref = deps.refOf(id);
    if (!ref) return;
    const mine = ++gen;
    const connection = dbRefLabel(ref);
    setAsk({ tab: id, connection });
    try {
      const { entries } = await deps
        .sessionFor(ref)
        .request("db.history", dbRefParams(ref));
      if (mine === gen) setAsk({ tab: id, connection, entries });
    } catch (e) {
      if (mine === gen) setAsk({ tab: id, connection, error: catalogError(e) });
    }
  }

  /** タブ id の接続の履歴を新しい順に返す（`kisui db history`。Dialog は出さない）。タブが無ければ undefined。聞けなければ投げる。 */
  async function historyOf(id: string): Promise<DbHistoryEntry[] | undefined> {
    const ref = deps.refOf(id);
    if (!ref) return undefined;
    const { entries } = await deps
      .sessionFor(ref)
      .request("db.history", dbRefParams(ref));
    return entries;
  }

  /** Dialog をやめる（キーを今のペインに戻す）。 */
  function closeHistory() {
    gen++;
    setAsk(null);
    deps.focusTerminal();
  }

  /** Dialog で選んだ SQL を、そのタブの入力欄に入れる（実行はしない）。Dialog を閉じて、キーを入力欄に戻す。 */
  function chooseHistory(sql: string) {
    const a = untrack(ask);
    gen++;
    setAsk(null);
    if (a && deps.refOf(a.tab)) deps.setDraft(a.tab, sql);
    deps.focusTerminal();
  }

  return {
    historyAsk: ask,
    openHistory,
    closeHistory,
    chooseHistory,
    historyOf,
  };
}
