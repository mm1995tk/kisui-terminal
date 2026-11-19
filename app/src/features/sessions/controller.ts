// マシンへの接続の持ち物と操作（C3〜C7）。サイドバーに出るのは「ローカル」と、足したマシンだけ。起動時は、そのどれにも自動でつなぐ（C5）。
// マシンを足す・名前を変える・外す、つなぐ・切る・つなぎ直す、ssh の質問（パスワードなど）への答えを受け持つ。
// つないだマシンごとに、接続（Session）・ツリー（WorkspaceTrees）・ターミナル（TermGroups）を 1 組ずつ持つ。
// 一覧やフォーカスの知らせを受けたあとにワークスペースの側ですること（フォーカスを直す・最初のワークスペースを作る・ペインの頼み）は hooks で外へ渡す。
// 画面にも Tauri にも触らない。殻への頼みは ShellApi（shell.ts）、記録は KeyValueStore で受け取る。
import { T } from "../../i18n/index.ts";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";

import type {
  Workspace,
  WorkspaceId,
} from "../../infrastructure/rpc/protocol.ts";
import { WorkspaceTrees } from "../file-tree/trees.ts";
import type { KeyValueStore } from "../keyValueStore.ts";
import { TermGroups } from "../terminal/group.ts";
import { machineColors } from "./colors.ts";
import {
  addMachine,
  labelOf as machineLabelOf,
  loadMachines,
  mergeMachines,
  recordToSave,
  removeMachine,
  renameMachine,
  saveMachines,
  type ConfigMachine,
  type Machine,
} from "./machines.ts";
import { Session, type PaneEvent, type SessionState } from "./session.ts";
import { LOCAL, type AskpassRequest, type ShellApi } from "./shell.ts";
import { statusLine, type MachineStatus } from "./status.ts";

/** 接続の知らせを受けたあとに、ワークスペースの側ですること。 */
export interface SessionHooks {
  /** ツリーの中身が変わった（描き直す） */
  treeChanged(): void;
  /** ターミナルの並びが変わった（描き直す） */
  termChanged(): void;
  /** つないで最初に分かった一覧（マシンごとに 1 回だけ）。空なら、ワークスペースを作るかを決める */
  firstList(target: string, list: Workspace[]): void;
  /** マシン target の shj のフォーカスが変わった */
  shjFocus(target: string, id: WorkspaceId | null): void;
  /** shj が端末のコマンドで頼んだこと（欄を出す・ツリーへ・URL を開く、など） */
  pane(target: string, ev: PaneEvent, s: Session): void;
}

/** createSessions が返す持ち物。 */
export type Sessions = ReturnType<typeof createSessions>;

/** 接続の持ち物を作る。足したマシンの記録を読み、起動したら「ローカル」と足したマシンにつなぎ、マシンごとの接続・状態・ワークスペースの一覧を持つ。 */
export function createSessions(deps: {
  api: ShellApi;
  /** 足したマシンなどの記録の置き場 */
  store: KeyValueStore | undefined;
  /** 手元の設定ファイルで決めたマシン */
  config: ConfigMachine[];
  hooks: SessionHooks;
}) {
  const { api, store, hooks } = deps;
  // ~/.ssh/config のホスト（マシンを足すときの候補）
  const [hosts, setHosts] = createSignal<string[]>([]);
  // 足したマシン（サイドバーには、これと「ローカル」だけを出す）
  // GUI で足したマシンの記録（設定ファイルと重なって出ていないものも含む）
  let saved = loadMachines(store);
  // 設定ファイルのマシン（fixed）が先、そのあとに足したマシン
  const [machines, setMachines] = createSignal<Machine[]>(
    mergeMachines(deps.config, saved),
  );
  const targets = createMemo(() => [LOCAL, ...machines().map((m) => m.target)]);
  const labelOf = (t: string) => machineLabelOf(machines(), t);
  const fixedOf = (t: string) =>
    machines().some((m) => m.target === t && m.fixed);
  function updateMachines(next: Machine[]) {
    setMachines(next);
    saved = recordToSave(next, saved, deps.config);
    saveMachines(store, saved);
  }
  const [sessions, setSessions] = createSignal<Record<string, Session>>({});
  const [states, setStates] = createSignal<Record<string, SessionState>>({});
  const [workspaces, setWorkspaces] = createSignal<Record<string, Workspace[]>>(
    {},
  );
  const offStates = new Map<string, () => void>();
  /** つないで最初の一覧を見たマシン（空なら自動でワークスペースを作る。作るのは 1 回だけ） */
  const started = new Set<string>();
  // マシンごとのツリー（D2）。中身は WorkspaceTrees が持ち、変わったら hooks.treeChanged で描き直させる
  const trees = new Map<string, WorkspaceTrees>();
  // マシンごと・ワークスペースごとのターミナル（F1・F4）。並びが変わったら hooks.termChanged で描き直させる（TermGroup は signal ではない）
  const termGroups = new Map<string, TermGroups>();
  const [asks, setAsks] = createSignal<AskpassRequest[]>([]);
  // リモートを足す窓を出しているか。足すためにつないでいる最中のマシン、足せなかった理由
  const [adding, setAdding] = createSignal(false);
  const [addPending, setAddPending] = createSignal<Machine | null>(null);
  const [addError, setAddError] = createSignal<string | undefined>();
  // 名前を変えているマシン（マシンのダイアログの行が入力欄になる）、変えられなかった理由
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [renameError, setRenameError] = createSignal<string | undefined>();
  // 「あと何秒」を動かす
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 1000);

  // await の後は Owner が無いので、onCleanup は先に登録する
  const offs: (() => void)[] = [];
  onCleanup(() => {
    clearInterval(tick);
    offs.forEach((f) => f());
    for (const s of Object.values(sessions())) void s.close();
  });
  onMount(async () => {
    const found = await api.listSshHosts().catch(() => []);
    setHosts(found);
    offs.push(
      await api.onAskpass((e) => setAsks((a) => [...a, e])),
      await api.onAskpassDone((id) =>
        setAsks((a) => a.filter((x) => x.requestId !== id)),
      ),
    );
    // 質問の窓口を用意してから、「ローカル」と足したマシンにつなぐ
    for (const t of targets()) connect(t);
  });

  /** マシンごとの shj のフォーカス（今いる GUI のワークスペースが無いとき、入る先を決めるのに使う）。 */
  function shjFocuses(): Record<string, WorkspaceId | null> {
    return Object.fromEntries(
      Object.entries(sessions()).map(([t, s]) => [t, s.focus]),
    );
  }

  /** マシンの状態の 1 行（サイドバーの見出しの下と、マシンのダイアログ）。 */
  function statusOf(t: string): MachineStatus {
    return sessions()[t]
      ? statusLine(states()[t], now())
      : { text: T("status.disconnected"), title: "", retry: "again" };
  }

  function connect(target: string) {
    const old = sessions()[target];
    if (old) {
      if (old.state.kind === "failed" || old.state.kind === "superseded") {
        old.retry();
        return;
      }
      return; // つないでいる最中、またはつながっている
    }
    const s = new Session(api, target);
    const tr = new WorkspaceTrees({
      request: (method, params) => s.request(method, params),
      onChange: () => hooks.treeChanged(),
      onError: (m) => console.warn(`[${target}] ${m}`),
    });
    trees.set(target, tr);
    const group = new TermGroups(
      s,
      () => hooks.termChanged(),
      (m) => console.warn(`[${target}] ${m}`),
    );
    termGroups.set(target, group);
    const offTerm = s.onTerm((e) => group.handle(e));
    const off = s.onState((st) => {
      // つなぎ直したら、ターミナルの溜めた出力を続きから取り直す（右下に出す前なら何もしない）
      if (st.kind === "connected") group.reconnected();
      setStates((m) => ({ ...m, [target]: st }));
      // つなぎ直したら、今のワークスペースのツリーと git の印を取り直す
      if (st.kind === "connected") tr.reconnected();
    });
    const offTree = s.onTreeChanged((n) => tr.handleTreeChanged(n));
    const offGit = s.onGitChanged((n) => tr.handleGitChanged(n));
    const offWs = s.onWorkspaces((ws) => {
      tr.retain(ws.map((w) => w.id));
      // プライマリターミナルで cd してフォルダが切り替わったワークスペースは、ツリーを捨てて取り直す
      for (const w of ws) {
        const before = workspaces()[target]?.find((x) => x.id === w.id);
        if (before && before.folder !== w.folder) tr.reset(w.id);
      }
      group.sync(ws);
      setWorkspaces((m) => ({ ...m, [target]: ws }));
      // つないで最初に分かった一覧が空なら、ワークスペースを 1 つ作る（何も無い画面から始めない。決めるのは hooks.firstList）。
      // 閉じて空になったときは作らない
      if (!started.has(target) && s.state.kind === "connected") {
        started.add(target);
        hooks.firstList(target, ws);
      }
    });
    const offFocus = s.onFocus((id) => hooks.shjFocus(target, id));
    const offPane = s.onPane((ev) => hooks.pane(target, ev, s));
    offStates.set(target, () => {
      offTerm();
      off();
      offTree();
      offGit();
      offWs();
      offFocus();
      offPane();
    });
    setSessions((m) => ({ ...m, [target]: s }));
    setStates((m) => ({ ...m, [target]: s.state }));
    s.start();
  }

  async function disconnect(target: string) {
    const s = sessions()[target];
    if (!s) return;
    offStates.get(target)?.(); // close() の closed を一覧に書き戻させない
    offStates.delete(target);
    trees.delete(target);
    termGroups.delete(target); // シェルは止めない（ワークスペースは shj に残る）
    started.delete(target);
    setSessions(({ [target]: _, ...rest }) => rest);
    setStates(({ [target]: _, ...rest }) => rest);
    setWorkspaces(({ [target]: _, ...rest }) => rest);
    await s.close();
  }

  /** 「足す」を押した。ssh でつなぎ（kisui が無ければ確認して送り）、つながったら保存する（下の effect）。 */
  function submitAdd(target: string, name: string) {
    const r = addMachine(machines(), target, name);
    if ("error" in r) {
      setAddError(r.error);
      return;
    }
    const m = r.machines[r.machines.length - 1];
    setAddError(undefined);
    setAddPending(m);
    connect(m.target);
  }

  // 足すためにつないだマシンの結果を待つ。つながったら保存して窓を閉じ、つなげなければ理由を窓に出して保存しない
  createEffect(() => {
    const p = addPending();
    if (!p) return;
    const st = states()[p.target];
    if (!st) return;
    untrack(() => {
      if (st.kind === "connected") {
        const r = addMachine(machines(), p.target, p.name);
        if ("machines" in r) updateMachines(r.machines);
        setAddPending(null);
        setAdding(false);
      } else if (st.kind === "failed" || st.kind === "superseded") {
        setAddError(
          st.kind === "failed"
            ? T("err.machine.connect", {
                machine: labelOf(p.target),
                message: st.message,
              })
            : T("err.machine.usedByOther", { machine: labelOf(p.target) }),
        );
        setAddPending(null);
        void disconnect(p.target);
      }
    });
  });

  /** 「キャンセル」と Esc。つないでいる最中ならつなぐのをやめる（保存しない）。 */
  function cancelAdd() {
    const p = addPending();
    setAddPending(null);
    setAdding(false);
    if (p) void disconnect(p.target);
  }

  function submitRename(target: string, name: string) {
    const r = renameMachine(machines(), target, name);
    if ("error" in r) {
      setRenameError(r.error);
      return;
    }
    updateMachines(r.machines);
    setRenaming(null);
  }

  /** 見出しのメニューの「外す」。記録から外し、GUI の接続を切る（そのマシンの kisui serve は止めない）。 */
  function removeFromSidebar(target: string) {
    updateMachines(removeMachine(machines(), target));
    void disconnect(target);
  }

  /** 見出しのそばのボタン。待ち時間中なら今すぐ、使い切った・引き継がれたあとならつなぎ直す。 */
  function retry(target: string) {
    const s = sessions()[target];
    if (!s) {
      connect(target); // 切った・つながなかったマシン
      return;
    }
    const st = s.state;
    if (st.kind === "failed" || st.kind === "superseded") connect(target);
    else if (
      (st.kind === "connecting" || st.kind === "reconnecting") &&
      st.retryAt !== undefined
    )
      s.retryNow();
  }

  // kisui を入れるかを聞くマシン（一度に 1 台。答えたら次のマシン）
  const installing = createMemo(() =>
    [...targets(), ...Object.keys(states())].find(
      (t) => states()[t]?.kind === "needs-install",
    ),
  );

  function reply(requestId: number, value: string | null) {
    setAsks((a) => a.filter((x) => x.requestId !== requestId));
    void api.askpassReply(requestId, value);
  }

  // 初めて出たマシンには色を割り当てて保存する（つなぐマシンが変わったときだけ計算し直す）
  const colors = createMemo(() => machineColors(store, targets()));

  return {
    /** ~/.ssh/config のホスト（マシンを足すときの候補） */
    hosts,
    /** 設定ファイルのマシン（fixed）が先、そのあとに足したマシン */
    machines,
    /** 「ローカル」と、足したマシンのつなぎ先 */
    targets,
    labelOf,
    fixedOf,
    sessions,
    states,
    /** マシンごとの、kisui serve のワークスペースの一覧 */
    workspaces,
    trees,
    termGroups,
    /** マシンごとの色（D4） */
    colors,
    /** 「あと何秒」を動かすための今の時刻 */
    now,
    statusOf,
    shjFocuses,
    connect,
    disconnect,
    retry,
    /** 答えを待っている ssh の質問（先頭から順に聞く） */
    asks,
    reply,
    /** リモートを足す窓を出しているか */
    adding,
    /** リモートを足す窓を出す */
    openAdd() {
      setAddError(undefined);
      setAdding(true);
    },
    /** 足すためにつないでいる最中のマシン */
    addPending,
    addError,
    submitAdd,
    cancelAdd,
    /** 名前を変えているマシン */
    renaming,
    /** マシン target の名前を変え始める（マシンのダイアログのその行が入力欄になる） */
    openRename(target: string) {
      setRenameError(undefined);
      setRenaming(target);
    },
    closeRename: () => setRenaming(null),
    renameError,
    submitRename,
    removeFromSidebar,
    /** kisui を入れるかを聞くマシン（一度に 1 台。答えたら次のマシン） */
    installing,
  };
}
