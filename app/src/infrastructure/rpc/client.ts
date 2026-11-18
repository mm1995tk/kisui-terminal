// プロトコルのクライアント。要求と応答の対応、通知の受け取り、1 行 1 メッセージの切り分け、
// 始まりの目印より前の行の読み捨てを受け持つ。
// 線（ssh の標準入出力や Tauri の IPC など）は Transport で差し替える。ブラウザの API には依存しない。

import type { GuiNotifications, Notifications, Requests } from "./protocol.ts";
import {
  ConnectionClosedError,
  ErrorCode,
  MARKER,
  RpcError,
  VERSION,
  isNotification,
  isRequest,
  isResponse,
  parseMessage,
  type Id,
  type ErrorResponse,
  type Message,
  type SuccessResponse,
} from "./message.ts";

/** 線。送る側だけ持つ。受け取ったテキストは Client.feed に、閉じたら Client.close に渡す。 */
export interface Transport {
  /** 1 メッセージ（JSON 1 件。末尾の改行は含まない）を送る。1 行にするための改行は Transport が足す。 */
  write(text: string): void;
  /** 接続を閉じる。 */
  close?(): void;
}

export interface ClientOptions {
  /**
   * 始まりの目印 `@@shj-rpc 1@@` を待つか。既定は待つ（ssh 越し）。
   * 待つ間は、目印の行より前の行を全部捨てる。
   */
  waitForMarker?: boolean;
  /** 読めない行や、対応する要求の無い応答など、捨てたものの報告先（ログ用）。 */
  onDiscard?: (reason: string, line: string) => void;
}

type NotificationHandler<P> = (params: P) => void;
type AnyNotificationHandler = (method: string, params: unknown) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class Client {
  private readonly transport: Transport;
  private readonly onDiscard?: (reason: string, line: string) => void;
  private ready: boolean;
  private buf = "";
  private nextId = 1;
  private closed = false;
  private closeReason?: string;
  private readonly pending = new Map<Id, Pending>();
  private readonly handlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly anyHandlers = new Set<AnyNotificationHandler>();
  private readonly closeHandlers = new Set<(reason?: string) => void>();

  constructor(transport: Transport, opts: ClientOptions = {}) {
    this.transport = transport;
    this.ready = !(opts.waitForMarker ?? true);
    this.onDiscard = opts.onDiscard;
  }

  /** 始まりの目印を受け取ったか（目印を待たない設定なら最初から true）。 */
  get isReady(): boolean {
    return this.ready;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** shj への要求。返事（結果）を待つ。エラー応答は RpcError で、接続が閉じたら ConnectionClosedError で失敗する。 */
  request<M extends keyof Requests>(
    method: M,
    params: Requests[M]["params"],
  ): Promise<Requests[M]["result"]> {
    if (this.closed) {
      return Promise.reject(new ConnectionClosedError(this.closeReason));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      try {
        this.transport.write(
          JSON.stringify({ jsonrpc: VERSION, id, method, params }),
        );
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /** shj への通知（返事は来ない）。 */
  notify<M extends keyof GuiNotifications>(
    method: M,
    params: GuiNotifications[M],
  ): void {
    if (this.closed) return;
    this.transport.write(JSON.stringify({ jsonrpc: VERSION, method, params }));
  }

  /** shj からの通知を受ける。外す関数を返す。知らない通知は何も起きない。 */
  on<M extends keyof Notifications>(
    method: M,
    handler: NotificationHandler<Notifications[M]>,
  ): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    const h = handler as (params: unknown) => void;
    set.add(h);
    return () => {
      set.delete(h);
    };
  }

  /** どの通知でも受ける（知らないメソッド名も含む）。ログや手元での確かめ用。 */
  onAny(handler: AnyNotificationHandler): () => void {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  /** 接続が閉じたときに呼ばれる。 */
  onClose(handler: (reason?: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  /** 線から受け取ったテキストを渡す。途中で切れていてもよい（改行までためる）。 */
  feed(chunk: string): void {
    if (this.closed) return;
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      this.handleLine(line);
      if (this.closed) return;
    }
  }

  /** 線が閉じた（または閉じる）。待っていた要求は全部 ConnectionClosedError で失敗する。 */
  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.buf = "";
    const err = new ConnectionClosedError(reason);
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(err);
    for (const h of [...this.closeHandlers]) h(reason);
    try {
      this.transport.close?.();
    } catch {
      // 閉じるときの失敗は報告先が無い
    }
  }

  private handleLine(line: string): void {
    if (!this.ready) {
      if (line.trim() === MARKER) this.ready = true;
      return; // 目印より前は捨てる
    }
    if (line.trim() === "") return;
    let msg: Message;
    try {
      msg = parseMessage(line);
    } catch (e) {
      this.onDiscard?.(e instanceof Error ? e.message : String(e), line);
      return;
    }
    if (isResponse(msg)) {
      this.handleResponse(msg, line);
    } else if (isRequest(msg)) {
      // shj から GUI への要求は今のところ無い。知らないものは「無い」と返す。
      try {
        this.transport.write(
          JSON.stringify({
            jsonrpc: VERSION,
            id: msg.id,
            error: {
              code: ErrorCode.MethodNotFound,
              message: `method not found: ${msg.method}`,
            },
          }),
        );
      } catch (e) {
        this.onDiscard?.(
          `failed to reply to : ${e instanceof Error ? e.message : String(e)}`,
          line,
        );
      }
    } else if (isNotification(msg)) {
      this.dispatch(msg.method, msg.params);
    }
  }

  private handleResponse(
    msg: SuccessResponse | ErrorResponse,
    line: string,
  ): void {
    const p = msg.id == null ? undefined : this.pending.get(msg.id);
    if (msg.id == null || !p) {
      // id を読めなかったエラーや、待っていない要求の返事
      this.onDiscard?.("response without a pending request", line);
      return;
    }
    this.pending.delete(msg.id);
    if ("error" in msg) {
      p.reject(new RpcError(msg.error));
    } else {
      p.resolve(msg.result);
    }
  }

  private dispatch(method: string, params: unknown): void {
    // 受け取る側の失敗で、あとの通知や応答の処理を止めない。
    const guard = (f: () => void) => {
      try {
        f();
      } catch (e) {
        this.onDiscard?.(
          `handler for ${method} threw: ${e instanceof Error ? e.message : String(e)}`,
          "",
        );
      }
    };
    for (const h of [...this.anyHandlers]) guard(() => h(method, params));
    const set = this.handlers.get(method);
    if (!set) return;
    for (const h of [...set]) guard(() => h(params));
  }
}
