// 切れたら自動でつなぎ直す接続（C4）。connectShj の上に、次の 3 つを足す。
//  - session.ping を一定間隔で送り、ssh が黙って切れたことに気づく
//  - 切れたら間隔を空けて何度かつなぎ直す。session.hello で resume を送り、同じ serverId なら
//    screen.get で全部取り直す。違えばワークスペースの一覧（hello.workspaces）から取り直す
//  - 状態（State）を外に出す。一覧の表示はこれを読む
//  - ワークスペースの一覧と shj のフォーカスを持ち、workspace.focus でフォーカスを移す（D1）
//  - ツリーと git の要求（tree.list / tree.watch / git.status）を今の接続に流し、
//    その通知（tree.changed / git.changed）をつなぎ直しをまたいで渡す（D2）
//  - 画面を購読し（view.subscribe）、欄の大きさ（view.resize）とテーマ（theme.get）を送り受けする。
//    screen.update を手元の画面に当て、当てたら screen.ack を返す（E1）。購読するのはファイルの欄・状態行・コマンド行（E3）
//  - キー・IME・マウス・貼り付け（input.*）を順に送り、clipboard.write を渡す（E2）
// Solid などの画面の仕組みには依存しない。

import { applyUpdate } from "../files/screen.ts";
import type { Client } from "../rpc/client.ts";
import { translate } from "../rpc/i18n.ts";
import { ErrorCode, RpcError } from "../rpc/message.ts";
import type {
  HelloResult,
  Notifications,
  Region,
  Requests,
  Screen,
  ScreenUpdate,
  TermId,
  Theme,
  WorkspaceId,
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
    }
  | { kind: "connected"; hello: HelloResult }
  /** 切れて、つなぎ直す順番を待っている（または試している） */
  | {
      kind: "reconnecting";
      /** 何回目の試みか（1 始まり） */
      attempt: number;
      max: number;
      /** 次の試みの時刻（ms）。試している最中は undefined */
      retryAt?: number;
      reason: string;
    }
  /**
   * リモートに shj が無い。ユーザーに聞くまで何も入れない。install() で入れ、declineInstall() で断る。
   * error は直前の入れ方が失敗した理由。
   */
  | { kind: "needs-install"; plan: InstallPlan; error?: string }
  /** shj を取って、確かめて、リモートに送っている */
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
  /** 読めなかった行などの報告先（ログ用） */
  onDiscard?: (reason: string, line: string) => void;
}

/** Session.request で送れる要求（ツリーと git）。 */
export type TreeMethod = "tree.list" | "tree.watch" | "git.status";
/** Session.request で送れる要求（ターミナル。F1）。 */
export type TermMethod =
  | "term.create"
  | "term.list"
  | "term.attach"
  | "term.close"
  | "term.restart"
  | "term.resize"
  | "term.input";
/** Session.request で送れる要求（画像の実体。E6）。 */
export type BlobMethod = "blob.get";
/** ターミナルの通知（F1）。method で見分ける。 */
export type TermEvent =
  | { method: "term.output"; params: Notifications["term.output"] }
  | { method: "term.exit"; params: Notifications["term.exit"] }
  | { method: "term.title"; params: Notifications["term.title"] };

/** Session.input で送れる入力。file.open も shj は入力と同じ並びで処理するので、同じ seq の数え方で送る。 */
export type InputMethod =
  | "input.key"
  | "input.composition"
  | "input.mouse"
  | "input.paste"
  | "input.focus"
  | "file.open";

/** 購読する領域。ファイルの欄と状態行とコマンド行と、その上に重ねるポップアップ（E4）を描く。 */
export const SUBSCRIBED_REGIONS: Region[] = [
  "files",
  "status",
  "cmdline",
  "overlay",
];

/** 1, 2, 4, 8, 16, 30 秒…（最後の値を繰り返す）。10 回で待ちは合わせて 151 秒ほど（ssh の接続待ちは別）。 */
export const DEFAULT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
/** 諦めるまでの試みの回数 */
export const DEFAULT_MAX_ATTEMPTS = 10;
/** 設計書 3 章：GUI は 15 秒ごとに session.ping を送る */
export const PING_INTERVAL_MS = 15000;
/** ping の返事を待つ時間（ms） */
export const PING_TIMEOUT_MS = 10000;

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
  /** 最後につながった shj の serverId と、GUI が持つ画面の版 */
  private serverId?: string;
  private rev = 0;
  /** screen.get の返事待ち。この間の screen.update は捨てる */
  private fetching = false;
  private _screen: Screen | null = null;
  private _workspaces: HelloResult["workspaces"] = [];
  /** shj がフォーカスしているワークスペース（workspace.list と workspace.focus で知る） */
  private _focus: WorkspaceId | null = null;
  private wake?: () => void;
  /** 入れている最中の id（「切る」で askpass の質問を取り消すのに使う） */
  private installId?: string;
  private generation = 0;
  private readonly stateHandlers = new Set<(s: SessionState) => void>();
  private readonly screenHandlers = new Set<(s: Screen) => void>();
  private readonly updateHandlers = new Set<(u: ScreenUpdate) => void>();
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
  /** 翻訳の表（i18n.get と i18n.changed で知る）。画面の文言はこれで訳してから持つ */
  private messages: Record<string, string> = {};
  /** テーマ（theme.get と theme.changed で知る） */
  private _theme: Theme | null = null;
  private readonly themeHandlers = new Set<(t: Theme) => void>();
  /** ファイルの欄の大きさ（マス目）。つなぎ直したら送り直す */
  private filesSize?: { cols: number; rows: number };
  /** 最後に送った入力の seq（つなぎ直しても増え続ける） */
  private inputSeq = 0;
  private readonly clipboardHandlers = new Set<(text: string) => void>();

  constructor(api: ShellApi, target: string, opts: SessionOptions = {}) {
    this.api = api;
    this.target = target;
    this.opts = {
      delays: opts.delays ?? DEFAULT_DELAYS,
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      pingIntervalMs: opts.pingIntervalMs ?? PING_INTERVAL_MS,
      pingTimeoutMs: opts.pingTimeoutMs ?? PING_TIMEOUT_MS,
      onDiscard: opts.onDiscard,
    };
  }

  get state(): SessionState {
    return this._state;
  }
  /** 今の画面（screen.get で取り、screen.update を当てたもの。つなぎ直しのたびに取り直す）。 */
  get screen(): Screen | null {
    return this._screen;
  }
  /** shj のテーマ。まだ知らなければ null。 */
  get theme(): Theme | null {
    return this._theme;
  }

  /** テーマが分かったとき・変わったとき。 */
  onTheme(h: (t: Theme) => void): () => void {
    this.themeHandlers.add(h);
    return () => this.themeHandlers.delete(h);
  }

  /**
   * ファイルの欄の大きさ（等幅のマス目の桁数と行数。タイトル行を含めない）を shj に送る（view.resize）。
   * 状態行とコマンド行は欄と同じ幅なので、同じ桁数を送る。ポップアップ（overlay）は欄の本文の上に
   * 重ねるので、欄と同じ桁数と行数を送る。
   * つながっていなければ覚えておき、つないだときに送る。
   */
  resize(size: { cols: number; rows: number }): void {
    const old = this.filesSize;
    if (old && old.cols === size.cols && old.rows === size.rows) return;
    this.filesSize = { ...size };
    const conn = this.conn;
    if (conn) this.sendResize(conn);
  }

  private sendResize(conn: Connection): void {
    const size = this.filesSize;
    if (!size) return;
    conn.client
      .request("view.resize", {
        regions: {
          files: size,
          status: { cols: size.cols },
          cmdline: { cols: size.cols },
          overlay: size,
        },
      })
      .catch((e) => this.discard("view.resize", e));
  }

  private discard(what: string, e: unknown): void {
    this.opts.onDiscard?.(
      `${what} failed: ${e instanceof Error ? e.message : String(e)}`,
      "",
    );
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
   * workspace.focus を送ってフォーカスを移す。画面はそのワークスペースのものに切り替わるので、取り直す。
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
    void this.fetchScreen(conn, gen, true);
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
   * workspace.close を送る。開いているファイルは shj が保存して閉じ、ターミナルを全部終わらせる。
   * プログラムが動いていれば busy（data.reason が "running"）で断られるので、force で送り直せる。
   * 保存できないファイルがあれば busy（data.reason が "unsaved"、data.paths がそのファイル）で、force でも閉じない。
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
   * ツリーと git（D2）・ターミナル（F1）・画像（E6）の要求を今の接続で送る。つながっていないときは投げる。
   * つなぎ直したら、呼ぶ側が取り直す（onState の connected で知る）。
   */
  async request<M extends TreeMethod | TermMethod | BlobMethod>(
    method: M,
    params: Requests[M]["params"],
  ): Promise<Requests[M]["result"]> {
    const conn = this.conn;
    if (!conn) throw new Error(`${this.target} につながっていません`);
    return conn.client.request(method, params);
  }

  /**
   * 入力（input.* と file.open）を今の接続で送る。seq はここで付ける（送るたびに 1 つ増やす）。返事は待たない。
   * shj は受け取った順に処理する。つながっていないときは捨てる（切れている間の入力は送り直さない）。
   * 送った seq を返す（送らなければ undefined）。shj が断ったら onError を呼ぶ（無ければ onDiscard に渡すだけ）。
   */
  input<M extends InputMethod>(
    method: M,
    params: Omit<Requests[M]["params"], "seq">,
    onError?: (e: unknown) => void,
  ): number | undefined {
    const conn = this.conn;
    if (!conn) return undefined;
    const seq = ++this.inputSeq;
    conn.client
      .request(method, { ...params, seq } as Requests[M]["params"])
      .catch((e) => (onError ? onError(e) : this.discard(method, e)));
    return seq;
  }

  /** clipboard.write（shj でコピーした。OS のクリップボードに入れる）。つなぎ直しても外れない。 */
  onClipboard(h: (text: string) => void): () => void {
    this.clipboardHandlers.add(h);
    return () => this.clipboardHandlers.delete(h);
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

  /** 全部の画面を取り直したとき（つなぎ直し、版の食い違い）。 */
  onScreen(h: (s: Screen) => void): () => void {
    this.screenHandlers.add(h);
    return () => this.screenHandlers.delete(h);
  }
  /** 差分の更新（版が続いているものだけ）。 */
  onUpdate(h: (u: ScreenUpdate) => void): () => void {
    this.updateHandlers.add(h);
    return () => this.updateHandlers.delete(h);
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
   * shj が無いリモートに、ユーザーが「入れる」と答えたあとで呼ぶ。GUI と同じ版の shj を取り、
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
      message: `shj が ${this.target} にありません（入れませんでした）`,
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
    if (first) {
      return attempt === 1
        ? { kind: "connecting", attempt, max }
        : { kind: "connecting", attempt, max, retryAt, reason };
    }
    return { kind: "reconnecting", attempt, max, retryAt, reason };
  }

  /**
   * 試みを繰り返す。startAttempt は数え始めの回数。reason は直前に切れた理由。
   * 古い run は generation が合わなくなって手を引く。
   */
  private async run(startAttempt: number, reason: string): Promise<void> {
    const gen = ++this.generation;
    const first = this.serverId === undefined;
    let lastError = reason;
    for (let attempt = startAttempt + 1; ; attempt++) {
      if (attempt > this.opts.maxAttempts) {
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
        await this.adopt(conn, gen);
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

  /** つながった接続を受け取る。同じ serverId なら screen.get、違えば一覧から取り直す。 */
  private async adopt(conn: Connection, gen: number): Promise<void> {
    const replaced =
      this.serverId !== undefined && this.serverId !== conn.hello.serverId;
    this.conn = conn;
    this._workspaces = conn.hello.workspaces;
    this.serverId = conn.hello.serverId;
    this.rev = conn.hello.rev;
    this.fetching = false;
    this.queued = [];
    this.refetch = false;
    // 引き継がれた。session.superseded か、閉じ損ねた接続への not_owner で気づく
    let superseded: SessionState | undefined;
    const offs = [
      conn.client.on("session.superseded", (p) => {
        superseded = { kind: "superseded", by: p?.by };
        // shj は送ったあと閉じるが、閉じ損ねても待たずにこちらから閉じる
        conn.client.close("superseded by another GUI");
      }),
      conn.client.on("screen.update", (u) => this.handleUpdate(conn, gen, u)),
      conn.client.on("i18n.changed", (t) => {
        if (gen !== this.generation || this.conn !== conn) return;
        // 言語が変わった。持っている画面は前の言語で訳してあるので、取り直す
        this.messages = t.messages;
        void this.fetchScreen(conn, gen, true);
      }),
      conn.client.on("theme.changed", (t) => {
        if (gen !== this.generation || this.conn !== conn) return;
        this.setTheme(t);
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
      conn.client.on("clipboard.write", (n) => {
        if (gen !== this.generation || this.conn !== conn) return;
        if (typeof n?.text !== "string") return;
        for (const h of [...this.clipboardHandlers]) h(n.text);
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

    this.setState({ kind: "connected", hello: conn.hello });
    this.emitWorkspaces();
    // hello にはフォーカスが無いので、workspace.list で尋ねる（画面の取り直しは待たせない）
    void this.fetchFocus(conn, gen);
    // 購読と大きさは接続ごと（shj は GUI ごとに覚える）なので、つなぐたびに送る。翻訳の表の返事だけ待つ
    // （購読すると shj が全部を screen.update で送ってくる。版が合わなければ screen.get で取り直す）
    await this.subscribe(conn, gen);

    if (replaced) {
      // shj が作り直された。古い画面は捨て、ワークスペースの一覧から取り直す
      this._screen = null;
    } else {
      await this.fetchScreen(conn, gen);
    }
  }

  /** 翻訳の表を先に受け取る（購読すると届く画面の文言を訳すのに要る）。ほかの返事は待たない。 */
  private async subscribe(conn: Connection, gen: number): Promise<void> {
    try {
      const t = await conn.client.request("i18n.get", {});
      if (gen !== this.generation || this.conn !== conn) return;
      this.messages = t.messages;
    } catch (e) {
      this.discard("i18n.get", e);
    }
    conn.client
      .request("view.subscribe", { regions: SUBSCRIBED_REGIONS })
      .catch((e) => this.discard("view.subscribe", e));
    this.sendResize(conn);
    conn.client
      .request("theme.get", {})
      .then((t) => {
        if (gen === this.generation && this.conn === conn) this.setTheme(t);
      })
      .catch((e) => this.discard("theme.get", e));
  }

  private setTheme(t: Theme): void {
    this._theme = t;
    for (const h of [...this.themeHandlers]) h(t);
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

  private handleUpdate(conn: Connection, gen: number, raw: ScreenUpdate): void {
    if (gen !== this.generation || this.conn !== conn) return;
    const u = translate(raw, this.messages);
    if (this.fetching) {
      // 取り直した画面に入っているかもしれない。返事が来てから決める（fetchScreen）
      this.queued.push(u);
      return;
    }
    if (u.baseRev !== this.rev) {
      void this.fetchScreen(conn, gen);
      return;
    }
    this.apply(conn, u);
  }

  /** 版の続いた更新を手元の画面に当て、描く側に渡してから screen.ack を返す。 */
  private apply(conn: Connection, u: ScreenUpdate): void {
    this.rev = u.rev;
    this._screen = applyUpdate(this._screen, u);
    // 描く側（Solid）は、渡されたその場で DOM を書き換える。だから渡し終えたら「描き終えた」として返す
    for (const h of [...this.updateHandlers]) h(u);
    conn.client.notify("screen.ack", { rev: u.rev });
  }

  /** screen.get の返事待ちの間に来た更新 */
  private queued: ScreenUpdate[] = [];
  /** 今の screen.get が終わったら、もう一度取り直す */
  private refetch = false;

  private async fetchScreen(
    conn: Connection,
    gen: number,
    force = false,
  ): Promise<void> {
    if (this.fetching) {
      // 取り直しは重ねない。ただし前の取り直しより後の画面が要るとき（フォーカスを移した）は、終わってからもう一度
      if (force) this.refetch = true;
      return;
    }
    this.fetching = true;
    this.refetch = false;
    this.queued = [];
    let ok = false;
    try {
      const raw = await conn.client.request("screen.get", {});
      if (gen !== this.generation || this.conn !== conn) return;
      const screen = translate(raw, this.messages);
      this._screen = screen;
      this.rev = screen.rev;
      ok = true;
      for (const h of [...this.screenHandlers]) h(screen);
    } catch (e) {
      // 切れたなら onClose が見る。shj が答えなかったときも ping が見る
      this.discard("screen.get", e);
    } finally {
      // つなぎ直したあとなら、新しい接続の取り直しの印を消さない
      if (this.conn === conn) this.fetching = false;
    }
    if (!ok) return;
    if (this.refetch) {
      void this.fetchScreen(conn, gen);
      return;
    }
    // 返事を待つ間に来た更新：取り直した画面より古いものは捨て、その画面から続くものは当てる。
    // shj は ack の来ない更新を 1 つまでしか送らないので、続くものを捨てると画面が止まる。
    const queued = this.queued;
    this.queued = [];
    for (const u of queued) {
      if (gen !== this.generation || this.conn !== conn) return;
      if (u.rev <= this.rev) continue;
      if (u.baseRev !== this.rev) {
        void this.fetchScreen(conn, gen);
        return;
      }
      this.apply(conn, u);
    }
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
