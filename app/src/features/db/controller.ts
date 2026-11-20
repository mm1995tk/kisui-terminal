// DB のタブ（#347）の持ち物と操作。MySQL / PostgreSQL のクライアントのタブで、SQL を打って結果を表で見る。
// DB への接続と SQL の実行は、接続を書いたマシンの kisui serve がする（db.connections・db.query・db.cancel。#345）。
// 画面にも Tauri にも触らない。
//
// 持ち物の分け方：
// - タブそのもの（どのワークスペースの、どのマシンの、どの接続か・並び・名前）は、GUI のワークスペースの記録（features/workspaces/model.ts の DbRef）。
//   ターミナルのタブ・ブラウザのタブと同じ所に並ぶので、並べ替え・別のワークスペースへの移動・閉じるは、タブ全体の操作（tabs/controller.ts）がそのまま扱う。
// - どのワークスペースが DB のタブを出しているかは、ブラウザのタブと同じ views（features/browser/tabs.ts）。
// - 入力欄の書きかけの SQL は、ここが KeyValueStore（webview の localStorage）に覚える（model.ts の loadDrafts・saveDrafts）。
//   タブが閉じたら捨てる。アプリを開き直したら戻る。
// - 結果・実行中の印・間違いは、メモリだけに持つ（開き直したら、もう一度実行する）。
// - パスワードは持たない。kisui serve が password_required を返したら画面で聞き、その 1 回の要求に付けて送るだけ
//   （ログインが通れば kisui serve が覚える。PR #354 の「資格情報の置き場」）。
import { T } from "../../i18n/index.ts";
import { createEffect, createMemo, createSignal, on, untrack } from "solid-js";

import {
  hasCapability,
  type Requests,
} from "../../infrastructure/rpc/protocol.ts";
import type { BrowserTabs } from "../browser/tabsStore.ts";
import type { KeyValueStore } from "../keyValueStore.ts";
import type { Sessions } from "../sessions/controller.ts";
import type { DbMethod, Session } from "../sessions/session.ts";
import type { Workspaces } from "../workspaces/controller.ts";
import {
  addDb,
  dbRefLabel,
  dbRefParams,
  dbTabsOf,
  newDbTabId,
  shownDb,
  type DbRef,
  type TabRef,
} from "../workspaces/model.ts";
import { statementsToRun } from "./statements.ts";
import {
  activeStatement,
  EMPTY_RUN,
  runInOrder,
  startStatement,
  stepResult,
  updateStatement,
  type DbRun,
} from "./results.ts";
import { MACHINE_COLORS } from "../sessions/colors.ts";
import {
  collectConnections,
  connectionOf,
  loadDrafts,
  newQueryId,
  PasswordCancelled,
  withPassword,
  queryFailure,
  saveDrafts,
  type DbChoice,
  type Drafts,
  type MachineConnections,
} from "./model.ts";
import {
  pageable,
  firstPage,
  pageParams,
  pageTarget,
  queueStep,
  sortedPage,
  steppedPage,
  sendQueued,
  type DbPage,
  nextSort,
  sortable,
  type PageStep,
} from "./paging.ts";
import { createDbExport } from "./exportController.ts";
import type { SaveTextFile } from "./export.ts";
import { createDbHistory } from "./historyController.ts";
import { createDbPropose } from "./proposeController.ts";
import { createDbStructure } from "./structureController.ts";
import { createDbTree } from "./treeController.ts";

/** createDbTabs が返す持ち物。 */
export type DbTabs = ReturnType<typeof createDbTabs>;

export type { DbRun, DbStatementRun } from "./results.ts";

/** 接続を選ぶ窓（リーダーの d n）に出すもの。 */
export interface DbPicker {
  /** 開いたタブを足すワークスペース */
  gws: string;
  /** まだ答えていないマシンがある */
  loading: boolean;
  choices: DbChoice[];
  /** 一覧の下に出す知らせ（設定の間違い・聞けなかったマシン） */
  notes: string[];
}

/** パスワードを聞いている窓に出すもの。 */
export interface DbPasswordAsk {
  tab: string;
  connection: string;
  machine: string;
  /** missing：どこにも無い、rejected：入力したものを DB が断った */
  reason: "missing" | "rejected";
}

/** DB のタブの持ち物を作る。接続を選んでタブを開く・SQL を実行する・取り消す・パスワードを聞く・書きかけの SQL を覚えるを受け持つ。 */
export function createDbTabs(deps: {
  /** 書きかけの SQL の置き場（使えない環境では undefined。そのときは覚えない） */
  store: KeyValueStore | undefined;
  sessions: Sessions;
  workspaces: Workspaces;
  browserTabs: BrowserTabs;
  /** ワークスペース gid のタブ ref を出す（features/workspaces/tabs/controller.ts の activateTab） */
  activateTab: (gid: string, ref: TabRef) => void;
  /** 今使っているペイン（DB のタブを出していれば SQL の入力欄）にキーを向ける */
  focusTerminal: () => void;
  /** 結果の書き出し（#349）：保存のダイアログを出して書く */
  saveFile: SaveTextFile;
  /** OS のクリップボードに入れ、書けたときだけ「コピーしました」を出す */
  copyToClipboard: (text: string) => Promise<void>;
  /** 少しの間だけ出る短い知らせ */
  showToast: (text: string) => void;
}) {
  const { store, focusTerminal } = deps;
  const { sessions, states, targets, labelOf, colors } = deps.sessions;
  const { gws, setGws, currentGws, cannot } = deps.workspaces;
  const { tabs } = deps.browserTabs;

  /** 今のワークスペースで出している DB のタブ。ほかのタブを出していれば undefined。 */
  const shownDbTab = createMemo(() => {
    const g = currentGws();
    if (!g) return undefined;
    const t = tabs();
    return shownDb(g, t.views[g.id], (id) => t.tabs.some((x) => x.id === id));
  });

  /** 記録にある DB のタブ（id → タブ）。 */
  const refs = createMemo(
    () => new Map(dbTabsOf(gws()).map((r) => [r.id, r] as const)),
  );
  const refOf = (id: string): DbRef | undefined => untrack(refs).get(id);

  // ---- 書きかけの SQL ----
  const [drafts, setDraftsState] = createSignal<Drafts>(loadDrafts(store));
  function writeDrafts(next: Drafts) {
    setDraftsState(next);
    saveDrafts(store, next, new Set(untrack(refs).keys()));
  }
  /** タブ id の入力欄の SQL を sql にする（打つたびに覚える）。 */
  function setDraft(id: string, sql: string) {
    if ((untrack(drafts)[id] ?? "") === sql) return;
    writeDrafts({ ...untrack(drafts), [id]: sql });
  }

  // ---- 結果と実行中の印 ----
  // 文を 2 つ以上順に実行したときは、文ごとの結果を持つ（#380。results.ts）
  const [runs, setRuns] = createSignal<Readonly<Record<string, DbRun>>>({});
  function setRun(id: string, f: (r: DbRun) => DbRun) {
    setRuns((all) => ({ ...all, [id]: f(all[id] ?? EMPTY_RUN) }));
  }
  const runOf = (id: string): DbRun => runs()[id] ?? EMPTY_RUN;
  /** タブ id の結果の場所に出している文の結果（まだ実行していなければ undefined） */
  const shownOf = (id: string) =>
    activeStatement(untrack(runs)[id] ?? EMPTY_RUN);

  /** 結果のタブ（#380）で、タブ id の結果の場所に index の文の結果を出す。無い位置なら何もしない。 */
  function showResult(id: string, index: number) {
    const r = untrack(runs)[id];
    if (!r || index < 0 || index >= r.statements.length || index === r.active)
      return;
    // 前に出していた結果のために押したページ送りを、ほかの文の結果に持ち越さない
    queuedSteps.delete(id);
    setRun(id, (cur) => ({ ...cur, active: index }));
  }
  /** 結果のタブを step（1 は次、-1 は前）だけ動かす。端では動かない。 */
  function stepResultTab(id: string, step: 1 | -1) {
    showResult(id, stepResult(untrack(runs)[id] ?? EMPTY_RUN, step));
  }

  // ---- パスワード ----
  const [passwordAsk, setPasswordAsk] = createSignal<DbPasswordAsk | null>(
    null,
  );
  let answer: ((p: string | null) => void) | undefined;
  /** パスワードを聞く窓を出し、答え（やめたら null）を待つ。前に聞いていたものは、やめたことにする。 */
  function askPassword(ref: DbRef, reason: "missing" | "rejected") {
    replyPassword(null, false);
    return new Promise<string | null>((resolve) => {
      answer = resolve;
      setPasswordAsk({
        tab: ref.id,
        connection: dbRefLabel(ref),
        machine: labelOf(ref.target),
        reason,
      });
    });
  }
  /** パスワードを聞く窓の答え（null はやめた）。答えは覚えない。refocus なら、キーを今のタブ（SQL の入力欄）に戻す。 */
  function replyPassword(password: string | null, refocus = true) {
    const a = answer;
    answer = undefined;
    setPasswordAsk(null);
    a?.(password);
    if (a && refocus) focusTerminal();
  }

  // ---- kisui serve への要求 ----
  /** ref のマシンの、DB を扱える接続。つながっていない・古い kisui serve なら、理由を投げる。 */
  function sessionFor(ref: Pick<DbRef, "target">): Session {
    const machine = labelOf(ref.target);
    const s = sessions()[ref.target];
    const st = states()[ref.target];
    if (!s || st?.kind !== "connected")
      throw new Error(T("db.err.disconnected", { machine }));
    if (!hasCapability(st.hello, "db"))
      throw new Error(T("db.err.noDb", { machine }));
    return s;
  }

  /**
   * タブ ref の接続に、DB の要求を送る。kisui serve が password_required を返したら、パスワードを聞いて、
   * それを付けて送り直す（DB が断ったら、また聞く）。聞く窓をやめたら PasswordCancelled を投げる。
   * SQL の実行（run）が使う。スキーマの一覧（#348）のような、ほかの db.* の要求も、これで送れば同じ流れになる。
   */
  async function request<M extends DbMethod>(
    ref: DbRef,
    method: M,
    params: Requests[M]["params"],
  ): Promise<Requests[M]["result"]> {
    return withPassword(
      (password) =>
        sessionFor(ref).request(
          method,
          password === undefined
            ? params
            : ({ ...params, password } as Requests[M]["params"]),
        ),
      (reason) => askPassword(ref, reason),
    );
  }

  /**
   * タブ id の SQL を 1 つの文として実行する。sql を渡せばそれを、無ければ入力欄の SQL を（入力欄は変えない）。空なら何もしない。
   * 同じタブで実行している間は、次を始めない（取り消してから）。結果が返る前にタブが閉じた・ほかの実行に替わったら、結果は捨てる。
   */
  async function run(id: string, sql?: string) {
    await runStatements(id, [sql ?? untrack(drafts)[id] ?? ""]);
  }

  /** 順に実行している間に取り消した（Esc）タブ。今の文の後の文を実行しない。 */
  const stopped = new Set<string>();

  /**
   * タブ id で、文 sqls を上から 1 つずつ実行する（#380）。文ごとに別の db.query を送り、1 つのトランザクションでは包まない
   * （文ごとにコミットされる）。文ごとに結果のタブを 1 つ足す。失敗した・取り消したら、そこで止める（後の文は送らない）。
   * 空の文は除く。実行するものが無い・同じタブで実行している間は何もしない。
   */
  async function runStatements(id: string, sqls: readonly string[]) {
    const list = sqls.filter((s) => s.trim() !== "");
    if (list.length === 0 || !refOf(id)) return;
    if (untrack(runs)[id]?.running) return;
    // 前の結果のために押したページ送りを、新しい SQL の結果に持ち越さない
    queuedSteps.delete(id);
    stopped.delete(id);
    const schema = tree.defaultSchemaOf(id);
    setRun(id, () => EMPTY_RUN);
    const out = await runInOrder(
      list,
      (i, sql, more) =>
        execute(id, i, firstPage(sql, schema), 0, false, { more }),
      () => stopped.has(id),
    );
    // 送った文が取り消しより先に終わっていた：残りの文はやめる（失敗した・取り消したときは execute が印を外した）
    if (out === "stopped") {
      stopped.delete(id);
      setRun(id, ({ running: _, ...r }) => r);
      flushQueued(id);
    }
  }

  /** タブ id の接続の種類（文の区切り方が違う。#375）。聞けなかったときは undefined（PostgreSQL の読み方を使う）。 */
  // 覚えるのはタブが開いている間。接続の設定を書き換えたら、タブを開き直す（SQL の失敗では捨てない）
  const kinds = new Map<string, "postgres" | "mysql">();
  async function kindOf(id: string) {
    const known = kinds.get(id);
    if (known) return known;
    const ref = refOf(id);
    if (!ref) return undefined;
    try {
      const { connections } = await sessionFor(ref).request(
        "db.connections",
        {},
      );
      const c = connectionOf(connections, ref);
      if (c) kinds.set(id, c.kind);
      return c?.kind;
    } catch {
      return undefined;
    }
  }

  /**
   * タブ id の入力欄の text（選んでいる範囲が selStart から selEnd。選んでいなければ、どちらもカーソルの位置）から、
   * 選んだ部分か、カーソルのある文を実行する（#375）。選んだ部分に文が 2 つ以上あれば、上から順に実行する（#380）。
   * 区切り方は接続の種類による。
   */
  async function runSelection(
    id: string,
    text: string,
    selStart: number,
    selEnd: number,
  ) {
    // 入力欄から実行したら、結果の場所はデータの側を出す（Structure を出していても。#379）
    structures.showView(id, "data");
    const kind = await kindOf(id);
    await runStatements(
      id,
      statementsToRun(text, selStart, selEnd, { mysql: kind === "mysql" }),
    );
  }

  /**
   * 実行している間に押したページ送りの向き（タブ id → 押した順）。結果が来たら、1 つずつその向きに送る
   * （リーダーの d j j j が、読み込みの速さによらず 3 ページ進むように）。実行が失敗した・取り消した・端に着いたら捨てる。
   */
  const queuedSteps = new Map<string, readonly PageStep[]>();

  /**
   * タブ id の結果のページを切り替える（#373）。結果を出した SQL を、offset を付けてもう一度送る（入力欄の SQL ではない）。
   * 実行している間なら、向きを覚えて結果が来てから送り、"queued" を返す。切り替えられない（ページ送りの無い結果・
   * 端のページ）なら、送らずに理由を返す。送ったら null。
   */
  function stepPage(
    id: string,
    step: PageStep,
  ): "none" | "edge" | "queued" | null {
    const r = untrack(runs)[id];
    if (r?.running) {
      queuedSteps.set(id, queueStep(queuedSteps.get(id) ?? [], step));
      return "queued";
    }
    const s = shownOf(id);
    if (!r || !s?.result || !s.page || !pageable(s.result)) return "none";
    const t = pageTarget(s.result, s.page, step);
    if (!t) return "edge";
    void execute(id, r.active, steppedPage(s.page, t.back), t.offset, true);
    return null;
  }

  /**
   * タブ id の結果（出している文の結果）を、列 column（0 から数える）で並べ替える（#377）。結果を出した SQL を ORDER BY を付けてもう一度送り、先頭のページから出す。
   * 同じ列を続けて押すと「昇順 → 降順 → 並べ替えなし」と進む。並べ替えられない（実行している間・結果が無い・包めない文）なら、送らずに false。
   */
  function sortBy(id: string, column: number): boolean {
    const r = untrack(runs)[id];
    const s = shownOf(id);
    if (!r || r.running || !s?.result || !s.page || !sortable(s.result))
      return false;
    if (column < 0 || column >= s.result.columns.length) return false;
    const sort = nextSort(s.page.sort, column) ?? undefined;
    void execute(id, r.active, sortedPage(s.page, sort), 0, true);
    return true;
  }

  /** 実行している間に押したページ送りを 1 つ送る（その結果が来たら、残りを続ける）。送れなければ残りも捨てる。 */
  function flushQueued(id: string) {
    const queued = queuedSteps.get(id) ?? [];
    queuedSteps.delete(id);
    const rest = sendQueued(queued, (s) => stepPage(id, s) === null);
    if (rest.length > 0) queuedSteps.set(id, rest);
  }

  /**
   * タブ id に page.sql を送り（offset が 0 より大きければ、その行数の後のページ。page.sort があれば、その列で並べ替えて）、
   * 結果をそのタブの index の文の結果に出す（index が新しい位置なら、文の結果のタブを足す）。rerun は、結果を出した SQL を
   * 読み直すだけの実行（履歴に残さない）。more は、順に実行していて後に文が残っている（#380）：うまくいっても実行中の印を外さない
   * （次の文が付け替える）。呼ぶ側が、同じタブで実行していないことを確かめてから呼ぶ。
   * ok：うまくいった、failed：失敗した・取り消した（印は外した）、gone：タブが閉じた・ほかの実行に替わった。
   */
  async function execute(
    id: string,
    index: number,
    page: DbPage,
    offset: number,
    rerun: boolean,
    opts: { more?: boolean } = {},
  ): Promise<"ok" | "failed" | "gone"> {
    const ref = refOf(id);
    if (!ref) return "gone";
    const queryId = newQueryId();
    const mine = () => untrack(runs)[id]?.running?.queryId === queryId;
    setRun(id, (r) =>
      startStatement(r, index, page.sql, { queryId, target: ref.target }),
    );
    try {
      const result = await request(ref, "db.query", {
        ...dbRefParams(ref),
        queryId,
        ...pageParams(page, offset, rerun),
      });
      if (!mine()) return "gone";
      setRun(id, (r) => {
        const next = updateStatement(r, index, (s) => ({
          sql: s.sql,
          result,
          page,
        }));
        if (opts.more) return next;
        const { running: _, ...rest } = next;
        return rest;
      });
      if (!opts.more) flushQueued(id);
      return "ok";
    } catch (e) {
      if (!mine()) return "gone";
      queuedSteps.delete(id);
      stopped.delete(id);
      if (e instanceof PasswordCancelled) {
        // 読み直し（ページ送り・並べ替え）なら、前の結果を残す。新しい文なら、取り消したことにする
        setRun(id, ({ running: _, ...r }) =>
          rerun
            ? r
            : updateStatement(r, index, (s) => ({
                sql: s.sql,
                failure: { kind: "cancelled" },
              })),
        );
        return "failed";
      }
      const f = queryFailure(e);
      setRun(id, ({ running: _, ...r }) =>
        updateStatement(r, index, (s) => ({
          sql: s.sql,
          failure:
            f.kind === "password"
              ? { kind: "error", message: T("db.err.password") }
              : f,
        })),
      );
      return "failed";
    }
  }

  /** db.cancel を送る（動いていなければ、kisui serve は not_found を返すだけ）。 */
  function cancelQuery(q: { queryId: string; target: string }) {
    const s = sessions()[q.target];
    void s?.request("db.cancel", { queryId: q.queryId }).catch(() => {});
  }

  /**
   * タブ id で実行している SQL を取り消す（結果は db.query の返事が db_error（cancelled）で返る）。文を順に実行している間なら、
   * 残りの文もやめる（#380）。実行していなければ何もしない。
   */
  function cancel(id: string) {
    const q = untrack(runs)[id]?.running;
    if (!q) return;
    stopped.add(id);
    cancelQuery(q);
  }

  /**
   * ref のマシンの kisui serve が、印 cap（capabilities）を持つか。yes：持つ、no：つながっていて持たない（古い版）、
   * unknown：つながっていないので分からない。
   */
  function capabilityOf(
    ref: Pick<DbRef, "target">,
    cap: string,
  ): "yes" | "no" | "unknown" {
    const st = untrack(states)[ref.target];
    if (st?.kind !== "connected") return "unknown";
    return hasCapability(st.hello, cap) ? "yes" : "no";
  }

  // ---- テーブルの構造（#379） ----
  const structures = createDbStructure({
    refOf,
    request,
    // 古いと言うのは、つながっていて印が無いときだけ。つながっていなければ送り、その失敗（つながっていない）を出す
    oldServe: (ref) => capabilityOf(ref, "db-structure") === "no",
    cancelQuery,
  });

  // ---- サイドバーの木（#348・#374） ----
  const tree = createDbTree({
    chooseTable: structures.chooseTable,
    refOf,
    sessionFor,
    request,
    shownDbTab,
    setDraft,
    run,
    isRunning: (id) => !!untrack(runs)[id]?.running,
    cancelQuery,
    // 既定のスキーマは、つながっていない（分からない）ときも選ばせない：つなぎ直した先が古い kisui serve なら、
    // 黙って無視されて DB の既定のスキーマで実行される（書き込む文も）ので
    schemaSupported: (ref) => capabilityOf(ref, "db-schema") === "yes",
    fail: cannot,
  });

  // ---- 結果の書き出しと、クエリの履歴（#349） ----
  const exporter = createDbExport({
    refOf,
    resultOf: (id) => shownOf(id)?.result,
    saveFile: deps.saveFile,
    copyToClipboard: deps.copyToClipboard,
    showToast: deps.showToast,
    fail: cannot,
    focusTerminal,
  });
  const history = createDbHistory({
    refOf,
    sessionFor,
    setDraft,
    focusTerminal,
  });

  // ---- コーディングエージェントが入力欄に SQL を書く頼み（kisui db propose。#382） ----
  const proposer = createDbPropose({
    currentGws,
    setGws,
    shownDbTab,
    refOf,
    draftOf: (id) => untrack(drafts)[id] ?? "",
    setDraft,
    labelOf,
    showToast: deps.showToast,
    focusTerminal,
  });

  // マシンとの接続が切れたら、そのマシンの頼みは取り下げとして扱う（聞く窓を残さない）
  createEffect(
    on(states, (st) =>
      proposer.withdrawProposesWhere((t) => st[t]?.kind !== "connected"),
    ),
  );

  // ---- 接続を選ぶ窓 ----
  const [picker, setPicker] = createSignal<DbPicker | null>(null);
  let pickerGen = 0;

  /**
   * 接続を選ぶ窓を出す（リーダーの d n・サイドバーの「+」のメニューの「DB」）。選んだ接続のタブを、ワークスペース gid
   * （省くと今のワークスペース）に足す。窓がつないでいる全部のマシンの kisui serve に一覧を聞き、答えた順に足していく。
   */
  function openPicker(gid?: string) {
    const g = gid ?? untrack(currentGws)?.id;
    if (!g) {
      cannot(T("cannot.db.title"), T("cannot.db.noWorkspace"));
      return;
    }
    const gen = ++pickerGen;
    const list: MachineConnections[] = [];
    const pending = new Set<string>();
    const show = () => {
      if (gen !== pickerGen) return;
      setPicker({
        gws: g,
        loading: pending.size > 0,
        ...collectConnections(list),
      });
    };
    const color = (t: string) => untrack(colors)[t] ?? MACHINE_COLORS[0];
    for (const t of untrack(targets)) {
      const st = untrack(states)[t];
      const s = untrack(sessions)[t];
      if (!s || st?.kind !== "connected") continue;
      const m: MachineConnections = {
        target: t,
        machine: labelOf(t),
        color: color(t),
      };
      list.push(m);
      if (!hasCapability(st.hello, "db")) {
        m.error = T("db.err.noDbShort");
        continue;
      }
      pending.add(t);
      s.request("db.connections", {})
        .then(
          (r) => {
            m.connections = r.connections;
            m.problems = r.problems;
          },
          (e: unknown) => {
            m.error = errorText(e);
          },
        )
        .finally(() => {
          pending.delete(t);
          show();
        });
    }
    show();
  }

  /** 接続を選ぶ窓で決めた：その接続の DB のタブを開いて出し、入力欄にキーを向ける。 */
  function choose(c: DbChoice) {
    const p = untrack(picker);
    pickerGen++;
    setPicker(null);
    if (!p) return;
    const ref: DbRef = {
      kind: "db",
      id: newDbTabId(),
      target: c.target,
      connection: c.connection.name,
      ...(c.connection.variant ? { variant: c.connection.variant } : {}),
    };
    setGws((s) => addDb(s, p.gws, ref));
    deps.activateTab(p.gws, ref);
  }

  /** 接続を選ぶ窓をやめる（キーを今のペインに戻す）。 */
  function closePicker() {
    pickerGen++;
    setPicker(null);
    focusTerminal();
  }

  // タブが記録から無くなったら（閉じた・ワークスペースごと閉じた）、書きかけを捨て、実行中のものは取り消す
  createEffect(
    on(refs, (alive) => {
      const all = untrack(runs);
      const gone = Object.keys(all).filter((id) => !alive.has(id));
      for (const id of gone) {
        queuedSteps.delete(id);
        stopped.delete(id);
        kinds.delete(id);
        const q = all[id].running;
        if (q) cancelQuery(q);
      }
      if (gone.length > 0)
        setRuns(
          Object.fromEntries(
            Object.entries(all).filter(([id]) => alive.has(id)),
          ),
        );
      tree.forget(alive);
      structures.forgetStructures(alive);
      const d = untrack(drafts);
      if (Object.keys(d).some((id) => !alive.has(id)))
        writeDrafts(
          Object.fromEntries(Object.entries(d).filter(([id]) => alive.has(id))),
        );
      if (untrack(passwordAsk) && !alive.has(untrack(passwordAsk)!.tab))
        replyPassword(null, false);
    }),
  );

  return {
    shownDbTab,
    refOf,
    /** タブ id の入力欄の SQL */
    draftOf: (id: string): string => drafts()[id] ?? "",
    setDraft,
    /** タブ id の結果・実行中の印・間違い */
    runOf,
    run,
    runSelection,
    stepPage,
    sortBy,
    showResult,
    stepResultTab,
    cancel,
    request,
    // サイドバーの木（#348・#374。treeController.ts）
    ...tree,
    // テーブルの構造と、結果の場所の切り替え（#379。structureController.ts）
    ...structures,
    // 結果の書き出し（#349。exportController.ts）と、クエリの履歴（historyController.ts）
    ...exporter,
    ...history,
    // コーディングエージェントが入力欄に SQL を書く頼み（#382。proposeController.ts）
    ...proposer,
    /** 結果の表で選んだセルの文字をクリップボードに入れる（#372） */
    copyCells: (text: string) => void deps.copyToClipboard(text),
    /** パスワードを聞いている窓（無ければ null） */
    passwordAsk,
    replyPassword: (password: string | null) => replyPassword(password),
    /** 接続を選ぶ窓（出していなければ null） */
    picker,
    openPicker,
    choose,
    closePicker,
  };
}

/** 一覧を聞けなかった理由の文。 */
function errorText(e: unknown): string {
  const f = queryFailure(e);
  return f.kind === "error" ? f.message : String(e);
}
