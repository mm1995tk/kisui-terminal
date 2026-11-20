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
  type DbQueryResult,
  type Requests,
} from "../../infrastructure/rpc/protocol.ts";
import type { BrowserTabs } from "../browser/tabsStore.ts";
import type { KeyValueStore } from "../keyValueStore.ts";
import type { Sessions } from "../sessions/controller.ts";
import type { DbMethod, Session } from "../sessions/session.ts";
import type { Workspaces } from "../workspaces/controller.ts";
import {
  addDb,
  dbTabsOf,
  newDbTabId,
  shownDb,
  type DbRef,
  type TabRef,
} from "../workspaces/model.ts";
import { MACHINE_COLORS } from "../sessions/colors.ts";
import {
  collectConnections,
  loadDrafts,
  newQueryId,
  PasswordCancelled,
  withPassword,
  queryFailure,
  saveDrafts,
  type DbChoice,
  type Drafts,
  type MachineConnections,
  type QueryFailure,
} from "./model.ts";
import { pageable, pageTarget, type DbPage, type PageStep } from "./paging.ts";
import { createDbExport } from "./exportController.ts";
import type { SaveTextFile } from "./export.ts";
import { createDbHistory } from "./historyController.ts";
import { createDbTree } from "./treeController.ts";

/** createDbTabs が返す持ち物。 */
export type DbTabs = ReturnType<typeof createDbTabs>;

/** タブ 1 つの、メモリだけに持つ状態。 */
export interface DbRun {
  /** 実行している SQL（db.cancel に渡す名前と、送ったマシン）。パスワードを聞いている間も入っている */
  running?: { queryId: string; target: string };
  /** 最後に実行できた SQL の結果 */
  result?: DbQueryResult;
  /** result がどの SQL のどのページか（ページ送り。#373）。result があれば入っている */
  page?: DbPage;
  /** 最後の実行が失敗した・取り消した理由（あれば result の代わりに出す） */
  failure?: Exclude<QueryFailure, { kind: "password" }>;
}

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
  const [runs, setRuns] = createSignal<Readonly<Record<string, DbRun>>>({});
  function setRun(id: string, f: (r: DbRun) => DbRun) {
    setRuns((all) => ({ ...all, [id]: f(all[id] ?? {}) }));
  }
  const runOf = (id: string): DbRun => runs()[id] ?? {};

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
        connection: ref.connection,
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
   * タブ id の SQL を実行する。sql を渡せばそれを、無ければ入力欄の SQL を（入力欄は変えない）。空なら何もしない。
   * 同じタブで実行している間は、次を始めない（取り消してから）。結果が返る前にタブが閉じた・ほかの実行に替わったら、結果は捨てる。
   */
  async function run(id: string, sql?: string) {
    const text = sql ?? untrack(drafts)[id] ?? "";
    if (text.trim() === "") return;
    await execute(id, { sql: text, back: [] }, 0);
  }

  /**
   * タブ id の結果のページを切り替える（#373）。結果を出した SQL を、offset を付けてもう一度送る（入力欄の SQL ではない）。
   * 切り替えられない（ページ送りの無い結果・端のページ・実行中）なら、送らずに理由を返す。送ったら null。
   */
  function stepPage(
    id: string,
    step: PageStep,
  ): "none" | "edge" | "running" | null {
    const r = untrack(runs)[id];
    if (r?.running) return "running";
    if (!r?.result || !r.page || !pageable(r.result)) return "none";
    const t = pageTarget(r.result, r.page, step);
    if (!t) return "edge";
    void execute(id, { sql: r.page.sql, back: t.back }, t.offset);
    return null;
  }

  /** タブ id に page.sql を送り（offset が 0 より大きければ、その行数の後のページ）、結果をそのタブに出す。 */
  async function execute(id: string, page: DbPage, offset: number) {
    const ref = refOf(id);
    if (!ref) return;
    if (untrack(runs)[id]?.running) return;
    const queryId = newQueryId();
    const mine = () => untrack(runs)[id]?.running?.queryId === queryId;
    setRun(id, (r) => ({ ...r, running: { queryId, target: ref.target } }));
    try {
      const result = await request(ref, "db.query", {
        connection: ref.connection,
        sql: page.sql,
        queryId,
        ...(offset > 0 ? { offset } : {}),
      });
      if (mine()) setRun(id, () => ({ result, page }));
    } catch (e) {
      if (!mine()) return;
      if (e instanceof PasswordCancelled) {
        setRun(id, ({ running: _, ...r }) => r);
        return;
      }
      const f = queryFailure(e);
      setRun(id, () => ({
        failure:
          f.kind === "password"
            ? { kind: "error", message: T("db.err.password") }
            : f,
      }));
    }
  }

  /** db.cancel を送る（動いていなければ、kisui serve は not_found を返すだけ）。 */
  function cancelQuery(q: { queryId: string; target: string }) {
    const s = sessions()[q.target];
    void s?.request("db.cancel", { queryId: q.queryId }).catch(() => {});
  }

  /** タブ id で実行している SQL を取り消す（結果は db.query の返事が db_error（cancelled）で返る）。実行していなければ何もしない。 */
  function cancel(id: string) {
    const q = untrack(runs)[id]?.running;
    if (q) cancelQuery(q);
  }

  // ---- 左の木のペイン（#348） ----
  const tree = createDbTree({
    store,
    refOf,
    sessionFor,
    request,
    shownDbTab,
    setDraft,
    run,
    isRunning: (id) => !!untrack(runs)[id]?.running,
    cancelQuery,
  });

  // ---- 結果の書き出しと、クエリの履歴（#349） ----
  const exporter = createDbExport({
    refOf,
    resultOf: (id) => untrack(runs)[id]?.result,
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
    stepPage,
    cancel,
    request,
    // 左の木のペイン（#348。treeController.ts）
    ...tree,
    // 結果の書き出し（#349。exportController.ts）と、クエリの履歴（historyController.ts）
    ...exporter,
    ...history,
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
