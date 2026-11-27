// マシンへの接続の持ち物と操作（C3〜C7）。サイドバーに出るのは「ローカル」と、設定ファイルの [[gui.machines]] のマシンだけ。起動時は、そのどれにも自動でつなぐ（C5）。
// マシンを足す・名前を変える・外す・ターミナルの始め方（始めるフォルダとシェル。termDefaults.ts）を変える（殻が config.local.toml に書く）、
// つなぐ・切る・つなぎ直す、ssh の質問（パスワードなど）への答えを受け持つ。
// つないだマシンごとに、接続（Session）・ツリー（WorkspaceTrees）・ターミナル（TermGroups）を 1 組ずつ持つ。
// 一覧やフォーカスの知らせを受けたあとにワークスペースの側ですること（フォーカスを直す・最初のワークスペースを作る・ペインの頼み）は hooks で外へ渡す。
// 画面にも Tauri にも触らない。殻への頼み（設定ファイルへの書き込みも）は ShellApi（shell.ts）、色の記録は KeyValueStore で受け取る。
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
import type { ReportProblem } from "../problem.ts";
import { TermGroups } from "../terminal/group.ts";
import { askpassMachine, type AskpassMachine } from "./askpass.ts";
import { machineColors } from "./colors.ts";
import {
  addMachine,
  fixedReason,
  fromConfig,
  labelOf as machineLabelOf,
  machineEditError,
  renameMachine,
  type ConfigMachine,
  type Machine,
} from "./machines.ts";
import { Session, type PaneEvent, type SessionState } from "./session.ts";
import {
  LOCAL,
  type AskpassRequest,
  type MachineEdit,
  type ShellApi,
} from "./shell.ts";
import { statusLine, type MachineStatus } from "./status.ts";
import {
  shellProblem,
  startDirProblem,
  termDefaultsByTarget,
  type TermDefaults,
} from "./termDefaults.ts";

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

/** 接続の持ち物を作る。起動したら「ローカル」と設定ファイルのマシンにつなぎ、マシンごとの接続・状態・ワークスペースの一覧を持つ。 */
export function createSessions(deps: {
  api: ShellApi;
  /** マシンの色などの記録の置き場 */
  store: KeyValueStore | undefined;
  /** 手元の設定ファイルのマシン（起動のときに読んだもの） */
  config: ConfigMachine[];
  /** 手元のマシンの、新しいターミナルが始まるフォルダとシェル（起動のときに読んだもの） */
  localTerminal?: TermDefaults | null;
  hooks: SessionHooks;
  /** できなかったこと（マシンを外せなかった）の知らせ */
  report?: ReportProblem;
}) {
  const { api, store, hooks } = deps;
  // ~/.ssh/config のホスト（マシンを足すときの候補）
  const [hosts, setHosts] = createSignal<string[]>([]);
  // 設定ファイルのマシン（サイドバーには、これと「ローカル」だけを出す）。Dialog で書き換えるたびに、殻が返す一覧に置き換える
  const [machines, setMachines] = createSignal<Machine[]>(
    fromConfig(deps.config),
  );
  const targets = createMemo(() => [LOCAL, ...machines().map((m) => m.target)]);
  const labelOf = (t: string) => machineLabelOf(machines(), t);
  const fixedOf = (t: string) =>
    machines().some((m) => m.target === t && m.fixed);
  /** config.local.toml に書き、書いたあとの一覧にする。書けなければ理由を返す（一覧は変えない）。 */
  async function writeMachine(edit: MachineEdit): Promise<string | undefined> {
    try {
      setMachines(fromConfig(await api.editMachine(edit)));
      return undefined;
    } catch (e) {
      return machineEditError(e);
    }
  }
  // マシンごとの、新しいターミナルが始まるフォルダとシェル（最後に読めた設定のもの。termDefaults.ts）
  const [termDefaults, setTermDefaults] = createSignal<
    Record<string, TermDefaults>
  >(
    termDefaultsByTarget({
      machines: deps.config,
      localTerminal: deps.localTerminal,
    }),
  );
  /**
   * マシン target の、新しいターミナルが始まるフォルダとシェル。設定ファイルを読み直して答える（ターミナルを始める要求のたびに呼ばれる。
   * 設定を変えた次のターミナルから効く）。読めない（書きかけで間違いがある、など）間は、最後に読めたものを答える。
   */
  async function readTermDefaults(target: string): Promise<TermDefaults> {
    try {
      setTermDefaults(termDefaultsByTarget(await api.configGui()));
    } catch {
      // 最後に読めたもののまま
    }
    return termDefaults()[target] ?? {};
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
  // リモートを足す Dialog を出しているか。足すためにつないでいる最中のマシン、足せなかった理由
  const [adding, setAdding] = createSignal(false);
  const [addPending, setAddPending] = createSignal<Machine | null>(null);
  const [addError, setAddError] = createSignal<string | undefined>();
  // 名前を変えているマシン（マシンのダイアログの行が入力欄になる）、変えられなかった理由
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [renameError, setRenameError] = createSignal<string | undefined>();
  // ターミナルの始め方を変えているマシンと、Dialog に初めに入れる値（今の設定）、変えられなかった理由
  const [termEditing, setTermEditing] = createSignal<{
    target: string;
    values: TermDefaults;
  } | null>(null);
  const [termEditError, setTermEditError] = createSignal<string | undefined>();
  // 書いている最中か（「保存」を続けて押しても 1 回だけ書く）
  const [termEditBusy, setTermEditBusy] = createSignal(false);
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
    // 質問の受け口を用意してから、「ローカル」と設定ファイルのマシンにつなぐ
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
    const s = new Session(api, target, {
      termDefaults: () => readTermDefaults(target),
    });
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

  /** 「足す」を押した。ssh でつなぎ（kisui が無ければ確認して送り）、つながったら config.local.toml に書く（下の effect）。 */
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

  // config.local.toml に書いている最中の、足すマシン（書き終わるまで、つながりの知らせで書き直さない）
  let addWriting: Machine | null = null;
  // 足すためにつないだマシンの結果を待つ。つながったら config.local.toml に書いて Dialog を閉じ、
  // つなげない・書けなければ理由を Dialog に出して、書かずに切る
  createEffect(() => {
    const p = addPending();
    if (!p) return;
    const st = states()[p.target];
    if (!st) return;
    untrack(() => {
      if (st.kind === "connected") {
        if (addWriting === p) return;
        addWriting = p;
        void writeMachine({
          kind: "add",
          ssh: p.target,
          name: p.name ?? null,
        }).then((err) => {
          addWriting = null;
          // 書いている間にやめた（キャンセル・Esc）なら、Dialog は閉じてある
          if (addPending() !== p) return;
          setAddPending(null);
          if (err === undefined) {
            setAdding(false);
          } else {
            setAddError(err);
            void disconnect(p.target);
          }
        });
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

  /** マシン target の名前を変える。確かめてから config.local.toml に書く。変えられなければ理由を返す（名前の入力欄と `kisui machine rename`）。 */
  async function renameNow(
    target: string,
    name: string,
  ): Promise<string | undefined> {
    const r = renameMachine(machines(), target, name);
    if ("error" in r) return r.error;
    const next = r.machines.find((m) => m.target === target);
    return writeMachine({
      kind: "rename",
      ssh: target,
      name: next?.name ?? null,
    });
  }

  /** 名前の入力欄の Enter。書けたら入力欄を閉じる（書けなければ理由を入力欄に出す）。 */
  function submitRename(target: string, name: string) {
    const r = renameMachine(machines(), target, name);
    if ("error" in r) {
      setRenameError(r.error);
      return;
    }
    void renameNow(target, name).then((err) => {
      if (renaming() !== target) return;
      if (err === undefined) setRenaming(null);
      else setRenameError(err);
    });
  }

  /** マシン target のターミナルの始め方を変える Dialog を出す（今の設定を読み直して、入力欄に入れる）。 */
  async function openTermEdit(target: string) {
    setTermEditError(undefined);
    const values = await readTermDefaults(target);
    setTermEditing({ target, values });
  }

  /**
   * ターミナルの始め方を変える Dialog の「保存」。形を確かめてから config.local.toml に書き、書けたら Dialog を閉じる（書けなければ理由を Dialog に出す）。
   * 空の欄は、その項目を消す（そのマシンの設定のままになる）。リモートのマシンは [[gui.machines]] の項目に、
   * 「ローカル」は [server] に書く。次に作るターミナルから効く（kisui serve は止めない）。
   */
  function submitTermEdit(startDirText: string, shellText: string) {
    const editing = termEditing();
    if (!editing || termEditBusy()) return;
    const problem = termProblem(startDirText, shellText);
    if (problem) {
      setTermEditError(problem);
      return;
    }
    setTermEditBusy(true);
    void writeTermDefaults(editing.target, startDirText, shellText).then(
      (err) => {
        setTermEditBusy(false);
        // 書いている間にやめた（Esc）なら、Dialog は閉じてある
        if (termEditing() !== editing) return;
        if (err === undefined) setTermEditing(null);
        else setTermEditError(err);
      },
    );
  }

  /** ターミナルの始め方の、書けない形の理由（前後の空白は除いて見る）。よければ undefined。 */
  function termProblem(startDirText: string, shellText: string) {
    return (
      startDirProblem(startDirText.trim()) ?? shellProblem(shellText.trim())
    );
  }

  /**
   * マシン target のターミナルの始め方を config.local.toml に書く（Dialog の「保存」と `kisui machine terminal`）。前後の空白は除き、
   * 空の値は、その項目を消す。リモートのマシンは [[gui.machines]] の項目に、「ローカル」は [server] に書く。書けなければ理由を返す。
   */
  async function writeTermDefaults(
    target: string,
    startDirText: string,
    shellText: string,
  ): Promise<string | undefined> {
    const problem = termProblem(startDirText, shellText);
    if (problem) return problem;
    const [startDir, shell] = [startDirText.trim(), shellText.trim()];
    const edit = { startDir: startDir || null, shell: shell || null };
    try {
      if (target === LOCAL) {
        const d = await api.editLocalTerminal(edit);
        setTermDefaults((m) => ({ ...m, [LOCAL]: d }));
      } else {
        const list = await api.editMachine({
          kind: "terminal",
          ssh: target,
          ...edit,
        });
        setMachines(fromConfig(list));
        setTermDefaults((m) => ({
          ...termDefaultsByTarget({ machines: list }),
          [LOCAL]: m[LOCAL] ?? {},
        }));
      }
      return undefined;
    } catch (e) {
      return machineEditError(e);
    }
  }

  /**
   * 見出しのメニューの「外す」。config.local.toml から消し、GUI の接続を切る（そのマシンの kisui serve は止めない）。
   * config.toml にもあるマシン（config.local.toml の項目が代わっていたもの）は、config.toml のものに戻って一覧に残るので、切らない。
   * 書けなければ、知らせに理由を出す。config.toml にだけあるマシン（fixed）は外さない（呼ぶ側が先に断る）。
   */
  function removeFromSidebar(target: string) {
    const label = labelOf(target);
    void removeNow(target).then((err) => {
      if (err !== undefined)
        deps.report?.({
          title: T("machine.remove.failed", { label }),
          error: err,
        });
    });
  }

  /**
   * マシン target を外す（removeFromSidebar と `kisui machine remove`）。外せなければ理由を返す。
   * config.toml にだけあるマシンは外さない（理由を返す）。
   */
  async function removeNow(target: string): Promise<string | undefined> {
    if (fixedOf(target)) return fixedReason();
    const err = await writeMachine({ kind: "remove", ssh: target });
    if (err !== undefined) return err;
    if (!targets().includes(target)) await disconnect(target);
    return undefined;
  }

  /**
   * マシンを足す（`kisui machine add`。足す Dialog の submitAdd と同じ決まり）。ssh でつなぎ（kisui が無ければ、Window で人に聞いて送り、
   * ssh の質問も Window で聞く）、つながったら config.local.toml に書く。つなげない・書けない・signal で取り下げられたときは、書かずに切り、
   * 理由を返す。足したら、足したマシンの ssh の行き先を返す。
   */
  async function addNow(
    target: string,
    name: string,
    signal: AbortSignal,
  ): Promise<{ target: string } | { error: string }> {
    const r = addMachine(machines(), target, name);
    if ("error" in r) return r;
    const m = r.machines[r.machines.length - 1];
    // 足す Dialog が同じ行き先につないでいる最中など、もう接続があるなら、触らない
    if (sessions()[m.target])
      return { error: T("machine.err.connecting", { label: m.target }) };
    connect(m.target);
    const s = sessions()[m.target];
    const st = await new Promise<SessionState | "aborted">((resolve) => {
      const done = (v: SessionState | "aborted") => {
        off();
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const check = (x: SessionState) => {
        if (
          x.kind === "connected" ||
          x.kind === "failed" ||
          x.kind === "superseded" ||
          x.kind === "closed"
        )
          done(x);
      };
      const onAbort = () => done("aborted");
      const off = s.onState(check);
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
      else check(s.state);
    });
    if (st !== "aborted" && st.kind === "connected") {
      const err = await writeMachine({
        kind: "add",
        ssh: m.target,
        name: m.name ?? null,
      });
      if (err === undefined) return { target: m.target };
      void disconnect(m.target);
      return { error: err };
    }
    // 取り下げられた・つなげなかった。足す Dialog と同じく、書かずに切る（足す前に切れていれば、切らない）
    if (sessions()[m.target] === s) void disconnect(m.target);
    if (st === "aborted") return { error: T("machine.err.addCancelled") };
    return {
      error:
        st.kind === "failed"
          ? T("err.machine.connect", {
              machine: labelOf(m.target),
              message: st.message,
            })
          : st.kind === "superseded"
            ? T("err.machine.usedByOther", { machine: labelOf(m.target) })
            : T("machine.err.addCancelled"),
    };
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
    /** 設定ファイルのマシン（config.toml の順、そのあとに config.local.toml にだけあるもの） */
    machines,
    /** 「ローカル」と、設定ファイルのマシンのつなぎ先 */
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
    /** ssh の質問の Dialog に出す、質問を出した接続の行き先（target）のマシン（名前・ssh の行き先・色） */
    askMachine: (target: string): AskpassMachine =>
      askpassMachine(machines(), colors(), target),
    reply,
    /** リモートを足す Dialog を出しているか */
    adding,
    /** リモートを足す Dialog を出す */
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
    renameNow,
    removeNow,
    addNow,
    readTermDefaults,
    writeTermDefaults,
    /** ターミナルの始め方（始めるフォルダとシェル）を変えているマシンと、今の設定の値 */
    termEditing,
    openTermEdit,
    closeTermEdit: () => setTermEditing(null),
    termEditError,
    termEditBusy,
    submitTermEdit,
    /** kisui を入れるかを聞くマシン（一度に 1 台。答えたら次のマシン） */
    installing,
  };
}
