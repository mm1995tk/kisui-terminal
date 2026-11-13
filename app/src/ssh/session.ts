// 切れたら自動でつなぎ直す接続（C4）。connectShj の上に、次の 3 つを足す。
//  - session.ping を一定間隔で送り、ssh が黙って切れたことに気づく
//  - 切れたら間隔を空けて何度かつなぎ直す。session.hello で resume を送り、つなぎ直したらワークスペースの一覧を取り直す
//  - 状態（State）を外に出す。一覧の表示はこれを読む
//  - ワークスペースの一覧と shj のフォーカスを持ち、workspace.focus でフォーカスを移す（D1）
//  - ツリーと git の要求（tree.list / tree.watch / git.status）を今の接続に流し、
//    その通知（tree.changed / git.changed）をつなぎ直しをまたいで渡す（D2）
//  - プライマリの shj が出した・隠した欄の知らせ（pane.show・pane.hide）を渡す（#553）
//  - kisui serve の版が kisui attach（GUI と同じ版）と違えば、聞かずに server.handover で新しい版に切り替えさせ、
//    つなぎ直す（#8。needsHandover）
// Solid などの画面の仕組みには依存しない。

import type { Client } from "../rpc/client.ts";
import { ErrorCode, RpcError } from "../rpc/message.ts";
import {
  hasCapability,
  type AttachInfo,
  type HelloResult,
  type Notifications,
  type Requests,
  type TermId,
  type UpdateReport,
  type WorkspaceId,
} from "../rpc/protocol.ts";
import type { InstallPlan, ShellApi } from "./api.ts";
import {
  connectShj,
  newId,
  ShjMissingError,
  type Connection,
} from "./connect.ts";

/** 接続の状態。一覧の表示はこれを読む。 */
export type SessionState =
  /** まだ一度もつながっていない。2 回目以降の試みでは max と reason、待ち時間中は retryAt が付く */
  | {
      kind: "connecting";
      attempt: number;
      max: number;
      retryAt?: number;
      reason?: string;
      /** 新しい版の kisui serve に切り替えている（server.handover を頼んだ・その後つなぎ直している） */
      switching?: true;
    }
  /**
   * つながっている。handoverError は、新しい版への切り替え（server.handover）が失敗して、
   * 古い版の kisui serve のまま使っているときの理由。
   */
  | { kind: "connected"; hello: HelloResult; handoverError?: string }
  /** 切れて、つなぎ直す順番を待っている（または試している） */
  | {
      kind: "reconnecting";
      /** 何回目の試みか（1 始まり） */
      attempt: number;
      max: number;
      /** 次の試みの時刻（ms）。試している最中は undefined */
      retryAt?: number;
      reason: string;
      /** 新しい版の kisui serve に切り替えている */
      switching?: true;
    }
  /**
   * リモートに kisui が無い。ユーザーに聞くまで何も入れない。install() で入れ、declineInstall() で断る。
   * error は直前の入れ方が失敗した理由。
   */
  | { kind: "needs-install"; plan: InstallPlan; error?: string }
  /** kisui を取って、確かめて、リモートに送っている */
  | { kind: "installing"; plan: InstallPlan }
  /** 回数を使い切った。ボタンで retry() できる */
  | { kind: "failed"; message: string }
  /**
   * 別の GUI に引き継がれた。自動ではつなぎ直さない（あとからつないだほうが勝つ。取り返すと取り合いになる）。
   * retry() でつなぎ直せる（そのときは、あちらの GUI が切れる）。
   * by は引き継いだ GUI（session.superseded で来たとき）。not_owner で気づいたときは無い。
   */
  | { kind: "superseded"; by?: Notifications["session.superseded"]["by"] }
  | { kind: "closed" };

/** Session の調整値。どれも省くと下の既定値。 */
export interface SessionOptions {
  /** つなぎ直しの間隔（ms）。n 回目の失敗の後は delays[n-1]、尽きたら最後の値。 */
  delays?: number[];
  /** 諦めるまでのつなぎ直しの回数。 */
  maxAttempts?: number;
  /** session.ping を送る間隔（ms） */
  pingIntervalMs?: number;
  /** ping の返事を待つ時間。これを過ぎたら切れたとみなす */
  pingTimeoutMs?: number;
  /** server.handover の返事を待つ時間。kisui serve の側の待ち（合わせて 95 秒）より長くする */
  handoverTimeoutMs?: number;
  /** 読めなかった行などの報告先（ログ用） */
  onDiscard?: (reason: string, line: string) => void;
}

/** Session.request で送れる要求（ツリーと git。tree.create・tree.rename・tree.delete は右クリックのメニューから）。 */
export type TreeMethod =
  | "tree.list"
  | "tree.watch"
  | "git.status"
  | "tree.create"
  | "tree.rename"
  | "tree.delete";
/** Session.request で送れる要求（ターミナル。F1）。 */
export type TermMethod =
  | "term.create"
  | "term.list"
  | "term.attach"
  | "term.close"
  | "term.restart"
  | "term.resize"
  | "term.input"
  | "term.cd"
  | "extra.close"
  | "layout.resize";
/** Session.request で送れる要求（動画の欄の中身。#555）。 */
export type BlobMethod = "media.read";
/** Session.request で送れる要求（プライマリの shj にファイルを開かせる）。 */
export type ShjMethod = "shj.open" | "shj.diff" | "shj.changesKey";
/** ターミナルの通知（F1）。method で見分ける。 */
export type TermEvent =
  | { method: "term.output"; params: Notifications["term.output"] }
  | { method: "term.exit"; params: Notifications["term.exit"] }
  | { method: "term.title"; params: Notifications["term.title"] };

/** shj が出した・隠した欄の知らせ（プライマリの shj の端末のコマンド。#553）。 */
export type PaneEvent =
  | { kind: "show"; workspaceId: WorkspaceId; termId: TermId }
  | { kind: "show-extra"; workspaceId: WorkspaceId; extraId: string }
  | { kind: "hide"; workspaceId: WorkspaceId }
  | { kind: "open-url"; workspaceId: WorkspaceId; url: string }
  | { kind: "explorer"; workspaceId: WorkspaceId; start?: boolean }
  | { kind: "changes"; workspaceId: WorkspaceId }
  /** `kisui update`（#94）。新しい版を調べ直して答える（reportUpdate）。欄の知らせではないが、serve からの欄の中のコマンドの知らせなので同じ道で渡す */
  | { kind: "update-check"; id: string };

/** 1, 2, 4, 8, 16, 30 秒…（最後の値を繰り返す）。10 回で待ちは合わせて 151 秒ほど（ssh の接続待ちは別）。 */
export const DEFAULT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
/** 諦めるまでの試みの回数 */
export const DEFAULT_MAX_ATTEMPTS = 10;
/** 設計書 3 章：GUI は 15 秒ごとに session.ping を送る */
export const PING_INTERVAL_MS = 15000;
/** ping の返事を待つ時間（ms） */
export const PING_TIMEOUT_MS = 10000;
/** server.handover の返事を待つ時間（ms） */
export const HANDOVER_TIMEOUT_MS = 120000;

/**
 * 1 つのつなぎ先への接続。切れたら自動でつなぎ直し、state で今の様子を伝える。
 * start() で始め、close() で閉じる。
 */
export class Session {
  readonly target: string;
  private readonly api: ShellApi;
  private readonly opts: Required<Omit<SessionOptions, "onDiscard">> &
    Pick<SessionOptions, "onDiscard">;
  private _state: SessionState = { kind: "connecting", attempt: 0, max: 0 };
  private conn?: Connection;
  /** 最後につながった shj の serverId と、その hello の版 */
  private serverId?: string;
  private rev = 0;
  private _workspaces: HelloResult["workspaces"] = [];
  /** shj がフォーカスしているワークスペース（workspace.list と workspace.focus で知る） */
  private _focus: WorkspaceId | null = null;
  private wake?: () => void;
  /** 入れている最中の id（「切る」で askpass の質問を取り消すのに使う） */
  private installId?: string;
  /**
   * 新しい版への切り替えを、この Session ですでに頼んだか。1 回だけ頼む（切り替えた先の版がまだ違っても、
   * 失敗しても、繰り返さない）。
   */
  private handoverTried = false;
  /** 切り替えを頼んでから、つなぎ直し終わるまで（connecting・reconnecting に switching を付ける） */
  private switching = false;
  private generation = 0;
  private readonly stateHandlers = new Set<(s: SessionState) => void>();
  private readonly workspaceHandlers = new Set<
    (w: HelloResult["workspaces"]) => void
  >();
  private readonly focusHandlers = new Set<(id: WorkspaceId | null) => void>();
  private readonly treeHandlers = new Set<
    (n: Notifications["tree.changed"]) => void
  >();
  private readonly gitHandlers = new Set<
    (n: Notifications["git.changed"]) => void
  >();
  private readonly termHandlers = new Set<(e: TermEvent) => void>();

  private readonly paneHandlers = new Set<(e: PaneEvent) => void>();

  constructor(api: ShellApi, target: string, opts: SessionOptions = {}) {
    this.api = api;
    this.target = target;
    this.opts = {
      delays: opts.delays ?? DEFAULT_DELAYS,
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      pingIntervalMs: opts.pingIntervalMs ?? PING_INTERVAL_MS,
      pingTimeoutMs: opts.pingTimeoutMs ?? PING_TIMEOUT_MS,
      handoverTimeoutMs: opts.handoverTimeoutMs ?? HANDOVER_TIMEOUT_MS,
      onDiscard: opts.onDiscard,
    };
  }

  get state(): SessionState {
    return this._state;
  }

  get workspaces(): HelloResult["workspaces"] {
    return this._workspaces;
  }
  get connection(): Connection | undefined {
    return this.conn;
  }
  /** shj がフォーカスしているワークスペース。知らないうちは null。 */
  get focus(): WorkspaceId | null {
    return this._focus;
  }

  onState(h: (s: SessionState) => void): () => void {
    this.stateHandlers.add(h);
    return () => this.stateHandlers.delete(h);
  }
  /** ワークスペースの一覧が変わったとき（つながったとき、workspace.changed）。 */
  onWorkspaces(h: (w: HelloResult["workspaces"]) => void): () => void {
    this.workspaceHandlers.add(h);
    return () => this.workspaceHandlers.delete(h);
  }
  /** shj のフォーカスが分かったとき・変わったとき（つながった後の workspace.list、focusWorkspace、フォーカス先が消えたとき）。 */
  onFocus(h: (id: WorkspaceId | null) => void): () => void {
    this.focusHandlers.add(h);
    return () => this.focusHandlers.delete(h);
  }

  /**
   * workspace.focus を送ってフォーカスを移す。
   * つながっていないとき・shj が断ったときは投げる（フォーカスは変えない）。
   * 返すのは、そのワークスペースで最後に使ったターミナル（無ければ undefined）（F2）。
   */
  async focusWorkspace(id: WorkspaceId): Promise<TermId | undefined> {
    const conn = this.conn;
    if (!conn) throw new Error(`${this.target} につながっていません`);
    const gen = this.generation;
    const r = await conn.client.request("workspace.focus", { id });
    if (gen !== this.generation || this.conn !== conn) return r.termId;
    this.setFocus(id);
    return r.termId;
  }

  /**
   * workspace.create を送る。フォルダ未定のワークスペースとそのプライマリターミナルができる。
   * つながっていないとき・shj が断ったときは投げる。
   */
  async createWorkspace(): Promise<{ id: WorkspaceId; termId: TermId }> {
    const conn = this.conn;
    if (!conn) throw new Error(`${this.target} につながっていません`);
    return conn.client.request("workspace.create", {});
  }

  /**
   * workspace.close を送る。ターミナルを全部終わらせる。
   * プログラムが動いていれば busy（data.reason が "running"）で断られるので、force で送り直せる。
   */
  async closeWorkspace(id: WorkspaceId, force = false): Promise<void> {
    const conn = this.conn;
    if (!conn) throw new Error(`${this.target} につながっていません`);
    await conn.client.request(
      "workspace.close",
      force ? { id, force } : { id },
    );
  }

  /**
   * ツリーと git（D2）・ターミナル（F1）・プライマリの shj（#551）の要求を今の接続で送る。つながっていないときは投げる。
   * つなぎ直したら、呼ぶ側が取り直す（onState の connected で知る）。
   */
  async request<M extends TreeMethod | TermMethod | BlobMethod | ShjMethod>(
    method: M,
    params: Requests[M]["params"],
  ): Promise<Requests[M]["result"]> {
    const conn = this.conn;
    if (!conn) throw new Error(`${this.target} につながっていません`);
    return conn.client.request(method, params);
  }

  /** pane.show・pane.hide（プライマリの shj が端末のコマンドで欄を出した・隠した）。つなぎ直しても外れない。 */
  onPane(h: (e: PaneEvent) => void): () => void {
    this.paneHandlers.add(h);
    return () => this.paneHandlers.delete(h);
  }

  /** `kisui update` への答え（update.result）を今の接続で送る。つながっていなければ何もしない（serve は時間切れで断る）。 */
  reportUpdate(id: string, outcome: UpdateReport): void {
    this.conn?.client.notify("update.result", { ...outcome, id });
  }

  /** tree.changed（開いているフォルダの中身が変わった）。つなぎ直しても外れない。 */
  onTreeChanged(h: (n: Notifications["tree.changed"]) => void): () => void {
    this.treeHandlers.add(h);
    return () => this.treeHandlers.delete(h);
  }
  /** git.changed（git の印が変わった）。つなぎ直しても外れない。 */
  onGitChanged(h: (n: Notifications["git.changed"]) => void): () => void {
    this.gitHandlers.add(h);
    return () => this.gitHandlers.delete(h);
  }

  /** term.output・term.exit・term.title（F1）。つなぎ直しても外れない。 */
  onTerm(h: (e: TermEvent) => void): () => void {
    this.termHandlers.add(h);
    return () => this.termHandlers.delete(h);
  }
  /** term.ack を今の接続で送る（F1）。つながっていなければ何もしない（つなぎ直したら term.attach で取り直す）。 */
  ackTerm(termId: string, seq: number): void {
    this.conn?.client.notify("term.ack", { termId, seq });
  }

  /** つなぎ始める。最初の接続で失敗したときも、つなぎ直しと同じ回数まで試す。 */
  start(): void {
    void this.run(0, "");
  }

  /** 諦めた後に、回数を数え直してつなぐ。 */
  retry(): void {
    if (this._state.kind !== "failed" && this._state.kind !== "superseded")
      return;
    void this.run(0, "");
  }

  /** 待たずに今すぐつなぎ直す（つなぎ直しの待ち時間のとき）。 */
  retryNow(): void {
    this.wake?.();
  }

  /**
   * kisui が無いリモートに、ユーザーが「入れる」と答えたあとで呼ぶ。GUI と同じ版の kisui を取り、
   * SHA-256 を確かめて入れ、つなぎ直す。失敗したら needs-install（error 付き）に戻る。
   */
  async install(): Promise<void> {
    const s = this._state;
    if (s.kind !== "needs-install") return;
    const gen = ++this.generation;
    const plan = s.plan;
    this.setState({ kind: "installing", plan });
    const id = newId();
    this.installId = id;
    try {
      await this.api.installRemote(id, this.target);
    } catch (e) {
      if (this.installId === id) this.installId = undefined;
      if (gen !== this.generation) return;
      this.setState({
        kind: "needs-install",
        plan,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (this.installId === id) this.installId = undefined;
    if (gen !== this.generation) return;
    await this.run(0, "");
  }

  /** 入れない。何も入れず、「つながりません」にする（つなぎ直すと、もう一度聞く）。 */
  declineInstall(): void {
    if (this._state.kind !== "needs-install") return;
    this.generation++;
    this.setState({
      kind: "failed",
      message: `kisui が ${this.target} にありません（入れませんでした）`,
    });
  }

  private async askInstall(gen: number): Promise<void> {
    try {
      const plan = await this.api.installPlan();
      if (gen === this.generation)
        this.setState({ kind: "needs-install", plan });
    } catch (e) {
      if (gen !== this.generation) return;
      this.setState({
        kind: "failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** 閉じる（session.bye。shj とシェルは止まらない）。 */
  async close(): Promise<void> {
    this.generation++;
    this.switching = false;
    this.wake?.();
    const c = this.conn;
    this.conn = undefined;
    this.setState({ kind: "closed" });
    // 入れている最中なら取り消す（質問の窓が残ったり、パスワードの聞き直しで入れ続けたりしないように）
    const installId = this.installId;
    this.installId = undefined;
    if (installId) void this.api.installCancel(installId).catch(() => {});
    await c?.close();
  }

  private setState(s: SessionState) {
    this._state = s;
    for (const h of [...this.stateHandlers]) h(s);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wake = undefined;
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wake = done;
    });
  }

  /** まだ一度もつながっていなければ connecting、一度つながっていれば reconnecting。 */
  private waiting(
    first: boolean,
    attempt: number,
    reason: string,
    retryAt?: number,
  ): SessionState {
    const max = this.opts.maxAttempts;
    const sw = this.switching ? { switching: true as const } : {};
    if (first) {
      return attempt === 1
        ? { kind: "connecting", attempt, max, ...sw }
        : { kind: "connecting", attempt, max, retryAt, reason, ...sw };
    }
    return { kind: "reconnecting", attempt, max, retryAt, reason, ...sw };
  }

  /**
   * 試みを繰り返す。startAttempt は数え始めの回数。reason は直前に切れた理由。
   * 古い run は generation が合わなくなって手を引く。
   */
  private async run(startAttempt: number, reason: string): Promise<void> {
    const gen = ++this.generation;
    const first = this.serverId === undefined;
    this.switching = false;
    let lastError = reason;
    for (let attempt = startAttempt + 1; ; attempt++) {
      if (attempt > this.opts.maxAttempts) {
        this.switching = false;
        this.setState({ kind: "failed", message: lastError });
        return;
      }
      this.setState(this.waiting(first, attempt, lastError));
      try {
        const conn = await connectShj(this.api, this.target, {
          resume:
            this.serverId !== undefined
              ? { serverId: this.serverId, rev: this.rev }
              : undefined,
          onDiscard: this.opts.onDiscard,
        });
        if (gen !== this.generation) {
          void conn.close();
          return;
        }
        const sw = await this.switchOver(conn, gen, () =>
          this.waiting(first, attempt, lastError),
        );
        if (sw === "resume") {
          attempt = 0; // つなぎ直しの回数は数え直す（次の周で 1 回目）
          continue;
        }
        if (sw === "stale") return;
        this.switching = false;
        await this.adopt(conn, gen, sw?.handoverError);
        return;
      } catch (e) {
        if (gen !== this.generation) return;
        if (e instanceof ShjMissingError) {
          // つなぎ直しても同じ。聞く段階へ進む（何も入れずに待つ）
          await this.askInstall(gen);
          return;
        }
        lastError = e instanceof Error ? e.message : String(e);
      }
      if (attempt >= this.opts.maxAttempts) continue; // 次の周で failed
      const d = this.opts.delays;
      const wait = d[Math.min(attempt - 1, d.length - 1)] ?? 1000;
      this.setState(
        this.waiting(first, attempt + 1, lastError, Date.now() + wait),
      );
      await this.sleep(wait);
      if (gen !== this.generation) return;
    }
  }

  /**
   * つないだ kisui serve の版が違えば、新しい版への切り替え（server.handover）を頼み、その後始末をする。
   *  - undefined：切り替えない（版が同じ・頼めない・この Session ですでに頼んだ）。呼ぶ側はそのまま受け取る
   *  - "resume"：切り替わった。古い serve の接続は閉じた。呼ぶ側は同じ serverId の resume でつなぎ直す
   *  - { handoverError }：断られた。古い serve は動き続けているので、呼ぶ側はそのまま受け取る
   *  - "stale"：待つ間に別の run・close に替わった。接続は閉じた
   * 返事の前に切れた・時間切れのときは投げる（handover を見る）。
   */
  private async switchOver(
    conn: Connection,
    gen: number,
    waiting: () => SessionState,
  ): Promise<undefined | "resume" | "stale" | { handoverError: string }> {
    const attach = conn.attach;
    if (this.handoverTried || !attach || !needsHandover(conn)) return;
    this.handoverTried = true;
    this.switching = true;
    this.setState(waiting());
    const failed = await this.handover(conn, attach);
    if (gen !== this.generation) {
      void conn.close();
      return "stale";
    }
    if (failed !== undefined) return { handoverError: failed };
    // 古い serve は返事のあと接続を閉じる。新しい serve は同じソケットで、同じ serverId の状態を持って
    // いるので、待たずに resume でつなぎ直す（欄は term.attach で引き継ぐ前の画面のまま続く）
    this.serverId = conn.hello.serverId;
    this.rev = conn.hello.rev;
    conn.client.close("handed over to the new kisui serve");
    return "resume";
  }

  /**
   * server.handover を頼む。切り替わったら undefined、kisui serve が断ったら（古い serve は動き続ける）その理由。
   * 返事の前に接続が切れた・時間切れのときは、切り替わったかは分からないので、switching を外して投げる
   * （普通のつなぎ直しに任せる）。
   */
  private async handover(
    conn: Connection,
    attach: AttachInfo,
  ): Promise<string | undefined> {
    let to: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      to = setTimeout(
        () => rej(new Error("server.handover timed out")),
        this.opts.handoverTimeoutMs,
      );
    });
    try {
      await Promise.race([
        conn.client.request("server.handover", {
          executable: attach.executable,
          ...(attach.env ? { env: attach.env } : {}),
        }),
        timeout,
      ]);
      return undefined;
    } catch (e) {
      if (e instanceof RpcError) return e.message;
      this.switching = false;
      conn.client.close(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      clearTimeout(to);
    }
  }

  /**
   * つながった接続を受け取る。ワークスペースの一覧は hello と workspace.list から取り直す。
   * handoverError は、新しい版への切り替えが断られて古い serve のまま使うときの理由。
   */
  private async adopt(
    conn: Connection,
    gen: number,
    handoverError?: string,
  ): Promise<void> {
    this.conn = conn;
    this._workspaces = conn.hello.workspaces;
    this.serverId = conn.hello.serverId;
    this.rev = conn.hello.rev;
    // 引き継がれた。session.superseded か、閉じ損ねた接続への not_owner で気づく
    let superseded: SessionState | undefined;
    const offs = [
      conn.client.on("session.superseded", (p) => {
        superseded = { kind: "superseded", by: p?.by };
        // shj は送ったあと閉じるが、閉じ損ねても待たずにこちらから閉じる
        conn.client.close("superseded by another kisui-terminal");
      }),
      conn.client.on("workspace.changed", (c) => {
        this._workspaces = applyWorkspaceChange(this._workspaces, c);
        this.emitWorkspaces();
        if (this._focus !== null && c.removed?.includes(this._focus))
          this.setFocus(null);
      }),
      conn.client.on("tree.changed", (n) => {
        if (gen !== this.generation || this.conn !== conn) return;
        for (const h of [...this.treeHandlers]) h(n);
      }),
      conn.client.on("git.changed", (n) => {
        if (gen !== this.generation || this.conn !== conn) return;
        for (const h of [...this.gitHandlers]) h(n);
      }),
      conn.client.on("pane.show", (n) => {
        if (gen !== this.generation || this.conn !== conn) return;
        if (typeof n?.workspaceId !== "string") return;
        const ev: PaneEvent | undefined =
          typeof n.termId === "string"
            ? { kind: "show", workspaceId: n.workspaceId, termId: n.termId }
            : typeof n.extraId === "string"
              ? {
                  kind: "show-extra",
                  workspaceId: n.workspaceId,
                  extraId: n.extraId,
                }
              : undefined;
        if (!ev) return;
        for (const h of [...this.paneHandlers]) h(ev);
      }),
      conn.client.on("pane.hide", (n) => {
        if (gen !== this.generation || this.conn !== conn) return;
        if (typeof n?.workspaceId !== "string") return;
        for (const h of [...this.paneHandlers])
          h({ kind: "hide", workspaceId: n.workspaceId });
      }),
      conn.client.on("browser.open", (n) => {
        if (gen !== this.generation || this.conn !== conn) return;
        if (typeof n?.workspaceId !== "string" || typeof n.url !== "string")
          return;
        for (const h of [...this.paneHandlers])
          h({ kind: "open-url", workspaceId: n.workspaceId, url: n.url });
      }),
      conn.client.on("explorer.focus", (n) => {
        if (gen !== this.generation || this.conn !== conn) return;
        if (typeof n?.workspaceId !== "string") return;
        for (const h of [...this.paneHandlers])
          h(
            n.start === true
              ? { kind: "explorer", workspaceId: n.workspaceId, start: true }
              : { kind: "explorer", workspaceId: n.workspaceId },
          );
      }),
      conn.client.on("update.check", (n) => {
        if (gen !== this.generation || this.conn !== conn) return;
        if (typeof n?.id !== "string") return;
        for (const h of [...this.paneHandlers])
          h({ kind: "update-check", id: n.id });
      }),
      conn.client.on("changes.focus", (n) => {
        if (gen !== this.generation || this.conn !== conn) return;
        if (typeof n?.workspaceId !== "string") return;
        for (const h of [...this.paneHandlers])
          h({ kind: "changes", workspaceId: n.workspaceId });
      }),
      ...(["term.output", "term.exit", "term.title"] as const).map((method) =>
        conn.client.on(method, (params) => {
          if (gen !== this.generation || this.conn !== conn) return;
          const e = { method, params } as TermEvent;
          for (const h of [...this.termHandlers]) h(e);
        }),
      ),
      startPing(
        conn.client,
        this.opts.pingIntervalMs,
        this.opts.pingTimeoutMs,
        (e) => {
          if (isNotOwner(e)) superseded ??= { kind: "superseded" };
        },
      ),
    ];
    conn.client.onClose((why) => {
      offs.forEach((f) => f());
      if (gen !== this.generation || this.conn !== conn) return;
      this.conn = undefined;
      if (superseded) {
        this.setState(superseded);
        return;
      }
      void this.run(0, why ?? "connection ended");
    });

    this.setState(
      handoverError === undefined
        ? { kind: "connected", hello: conn.hello }
        : { kind: "connected", hello: conn.hello, handoverError },
    );
    this.emitWorkspaces();
    // hello にはフォーカスが無いので、workspace.list で尋ねる
    void this.fetchFocus(conn, gen);
  }

  private setFocus(id: WorkspaceId | null): void {
    if (this._focus === id) return;
    this._focus = id;
    for (const h of [...this.focusHandlers]) h(id);
  }

  private async fetchFocus(conn: Connection, gen: number): Promise<void> {
    try {
      const r = await conn.client.request("workspace.list", {});
      if (gen !== this.generation || this.conn !== conn) return;
      this._workspaces = r.workspaces;
      this.emitWorkspaces();
      this.setFocus(r.focus);
    } catch (e) {
      // 切れたなら onClose が見る。フォーカスが分からないだけで、帯は出せる
      this.opts.onDiscard?.(
        `workspace.list failed: ${e instanceof Error ? e.message : String(e)}`,
        "",
      );
    }
  }

  private emitWorkspaces(): void {
    for (const h of [...this.workspaceHandlers]) h(this._workspaces);
  }
}

/** workspace.changed を一覧に当てる。 */
export function applyWorkspaceChange(
  workspaces: HelloResult["workspaces"],
  change: Notifications["workspace.changed"],
): HelloResult["workspaces"] {
  const ws = new Map(workspaces.map((w) => [w.id, w]));
  for (const w of change.added ?? []) ws.set(w.id, w);
  for (const w of change.updated ?? []) ws.set(w.id, w);
  for (const id of change.removed ?? []) ws.delete(id);
  return [...ws.values()];
}

/**
 * 動いている kisui serve を、新しい版に切り替えさせるか。kisui attach は GUI と同じ版の kisui（ローカルは
 * 同梱のもの、リモートは GUI の版のキャッシュ）なので、attach が名乗った版（attach.info）と serve の版
 * （hello の shj）を比べる。同じ形（version・commit）どうしなので、同じリリースの GUI と kisui は「同じ」に、
 * nightly どうし（version は X.Y.Z だけ）は commit で見分けられる。serve が server.handover を持たない
 * （#7 より前）か、attach が名乗らなかったときは切り替えない。
 */
export function needsHandover(
  conn: Pick<Connection, "hello" | "attach">,
): boolean {
  const a = conn.attach;
  if (!a || !hasCapability(conn.hello, "server.handover")) return false;
  const s = conn.hello.shj;
  return a.version !== s.version || a.commit !== s.commit;
}

/** 引き継がれたあとの古い接続が要求したときのエラー（not_owner）か。 */
export function isNotOwner(e: unknown): boolean {
  return e instanceof RpcError && e.code === ErrorCode.NotOwner;
}

/**
 * session.ping を intervalMs ごとに送る。timeoutMs 経っても返事が無い（またはエラー）なら
 * 切れたとみなして client を閉じる（閉じる前に onError に理由を渡す）。止める関数を返す。
 */
export function startPing(
  client: Client,
  intervalMs: number,
  timeoutMs: number,
  onError?: (e: unknown) => void,
): () => void {
  let pinging = false;
  const timer = setInterval(() => {
    if (pinging) return;
    pinging = true;
    let to: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      to = setTimeout(() => rej(new Error("ping timed out")), timeoutMs);
    });
    Promise.race([client.request("session.ping", {}), timeout])
      .catch((e) => {
        onError?.(e);
        client.close(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        clearTimeout(to);
        pinging = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
