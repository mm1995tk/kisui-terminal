// `kisui db propose`（#382）：コーディングエージェントが、DB のタブの入力欄に SQL を書く頼み。実行はしない（人が読んで実行する）。
// serve の db.propose を受け、今のワークスペースの、頼んだマシン・同じ接続（と変種）の DB のタブを探し（無ければ開き）、
// 入力欄が空ならそのまま書く。SQL があれば、上書きの前に窓で人に聞く。答え（db.proposed）は呼ぶ側が送る。
// フォーカスは移さない（今出しているタブも変えない）：人は別の作業をしていることがあるので、書いたことは短い知らせで伝える。
// エージェントの権限が許すかは、頼んだ serve が先に確かめている。画面にも Tauri にも触らない。
import { T } from "../../i18n/index.ts";
import { createSignal, untrack } from "solid-js";

import type {
  DbProposeReport,
  DbProposeRequest,
} from "../../infrastructure/rpc/protocol.ts";
import {
  addDb,
  dbRefLabel,
  newDbTabId,
  type DbRef,
  type Gws,
  type GwsState,
} from "../workspaces/model.ts";
import { proposeTab, replaceable } from "./propose.ts";

/** 上書きしてよいかを聞いている窓に出すもの。 */
export interface DbProposeAsk {
  /** 書く先のタブ */
  tab: string;
  /** 接続の名前（環境の変種があれば `接続 (変種)`） */
  connection: string;
  /** 接続を書いたマシンの名前 */
  machine: string;
  /** 今、入力欄にある SQL（上書きで消えるもの） */
  current: string;
  /** エージェントが書こうとしている SQL */
  sql: string;
}

/** kisui db propose の持ち物を作る。頼みを受けて書く・上書きを聞く・取り下げを受け持つ。 */
export function createDbPropose(deps: {
  /** 今のワークスペース（無ければ undefined） */
  currentGws: () => Gws | undefined;
  setGws: (f: (g: GwsState) => GwsState) => void;
  /** 今のワークスペースで出している DB のタブ（ほかのタブを出していれば undefined） */
  shownDbTab: () => DbRef | undefined;
  refOf: (id: string) => DbRef | undefined;
  /** タブ id の入力欄の SQL */
  draftOf: (id: string) => string;
  setDraft: (id: string, sql: string) => void;
  /** マシンの名前 */
  labelOf: (target: string) => string;
  /** 少しの間だけ出る短い知らせ */
  showToast: (text: string) => void;
  /** 今使っているペインにキーを向ける */
  focusTerminal: () => void;
  /** 新しいタブの id（テストで決める） */
  newId?: () => string;
}) {
  const [ask, setAsk] = createSignal<DbProposeAsk | null>(null);
  /** 聞いている頼み（マシンと頼みの id）と、その答えの口。 */
  let asking:
    | { key: string; answer: (a: "yes" | "no" | "withdrawn") => void }
    | undefined;
  /** 受けたが、まだ済んでいない頼み。 */
  const pending = new Set<string>();
  /** 順番を待つ間に取り下げられた頼み。 */
  const withdrawn = new Set<string>();
  /** 頼みは 1 つずつ順に扱う（聞く窓は 1 つ。前の頼みが書いた SQL を、次の頼みが見てから決める）。 */
  let queue: Promise<unknown> = Promise.resolve();
  const keyOf = (target: string, id: string) => `${target}\n${id}`;

  /**
   * マシン target の頼み rq を行う。書けたら written、人が上書きを断ったら declined、書けなければ理由を返す（投げない）。
   */
  function propose(
    target: string,
    rq: DbProposeRequest,
  ): Promise<DbProposeReport> {
    const key = keyOf(target, rq.id);
    pending.add(key);
    const done = queue
      .then(() => handle(target, rq, key))
      .catch((e: unknown): DbProposeReport => ({
        error: e instanceof Error ? e.message : String(e),
      }));
    queue = done.then(() => {
      pending.delete(key);
      withdrawn.delete(key);
    });
    return done;
  }

  async function handle(
    target: string,
    rq: DbProposeRequest,
    key: string,
  ): Promise<DbProposeReport> {
    // 取り下げられた頼みの答えは、serve がもう待っていない（捨てられる）
    const gone: DbProposeReport = { error: T("db.propose.err.withdrawn") };
    if (withdrawn.has(key)) return gone;
    const g = untrack(deps.currentGws);
    if (!g) return { error: T("db.propose.err.noWorkspace") };
    let ref = proposeTab(
      g.tabs,
      untrack(deps.shownDbTab)?.id,
      target,
      rq.connection,
      rq.variant,
    );
    if (!ref) {
      const made: DbRef = {
        kind: "db",
        id: (deps.newId ?? newDbTabId)(),
        target,
        connection: rq.connection,
        ...(rq.variant ? { variant: rq.variant } : {}),
      };
      deps.setGws((s) => addDb(s, g.id, made));
      ref = made;
    }
    const tab = ref.id;
    const connection = dbRefLabel(ref);
    const machine = deps.labelOf(target);
    const current = deps.draftOf(tab);
    if (!replaceable(current, rq.sql)) {
      const a = await new Promise<"yes" | "no" | "withdrawn">((answer) => {
        asking = { key, answer };
        setAsk({ tab, connection, machine, current, sql: rq.sql });
      });
      if (a === "withdrawn") return gone;
      if (a === "no") return { status: "declined" };
      // 聞いている間にタブが閉じられていたら、書く先が無い
      if (!deps.refOf(tab)) return { error: T("db.propose.err.closed") };
    }
    deps.setDraft(tab, rq.sql);
    deps.showToast(T("db.propose.written", { connection, machine }));
    return { status: "written" };
  }

  /** 聞いている窓を閉じて、答えを渡す。 */
  function settle(a: "yes" | "no" | "withdrawn") {
    const cur = asking;
    asking = undefined;
    setAsk(null);
    cur?.answer(a);
  }

  /** 上書きしてよいかの窓の答え（false はやめた）。キーを今のペインに戻す。 */
  function replyPropose(yes: boolean) {
    if (!asking) return;
    settle(yes ? "yes" : "no");
    deps.focusTerminal();
  }

  /**
   * マシン target の頼み id の取り下げ（serve が答えを待つのをやめた）。聞いている途中なら窓を閉じて書かない。
   * 順番を待っている頼みなら、順番が来ても何もしない。もう済んだ頼みなら何もしない。
   */
  function cancelPropose(target: string, id: string) {
    const key = keyOf(target, id);
    if (!pending.has(key)) return;
    if (asking?.key === key) {
      settle("withdrawn");
      deps.focusTerminal();
    } else withdrawn.add(key);
  }

  return {
    /** 上書きしてよいかを聞いている窓（無ければ null） */
    proposeAsk: ask,
    propose,
    replyPropose,
    cancelPropose,
  };
}
