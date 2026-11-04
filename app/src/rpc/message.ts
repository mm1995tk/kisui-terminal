// JSON-RPC 2.0 の線の上の形。Go 側の ui/gui/rpc に合わせてある。
// 設計は docs/design/gui-protocol.md の 3 章「土台」。

/** JSON-RPC のバージョン文字列。 */
export const VERSION = "2.0";

/** 始まりの目印。ssh のログインシェルが出す motd などを読み捨てるために、shj attach が最初に 1 行出す。 */
export const MARKER = "@@shj-rpc 1@@";

/** 標準のエラーコードと、このプロトコル独自のエラーコード（設計書 3 章の表）。 */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  IncompatibleProtocol: -32001,
  NotOwner: -32002,
  NotFound: -32003,
  Denied: -32004,
  Busy: -32005,
} as const;

const codeNames: Record<number, string> = {
  [-32700]: "parse_error",
  [-32600]: "invalid_request",
  [-32601]: "method_not_found",
  [-32602]: "invalid_params",
  [-32603]: "internal_error",
  [-32001]: "incompatible_protocol",
  [-32002]: "not_owner",
  [-32003]: "not_found",
  [-32004]: "denied",
  [-32005]: "busy",
};

/** コードの名前。知らないコードは "" */
export function codeName(code: number): string {
  return codeNames[code] ?? "";
}

export type Id = number | string;

export interface ErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** shj が返したエラー応答。 */
export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(e: ErrorObject) {
    const name = codeName(e.code);
    super(
      name
        ? `rpc error ${e.code} (${name}): ${e.message}`
        : `rpc error ${e.code}: ${e.message}`,
    );
    this.name = "RpcError";
    this.code = e.code;
    this.data = e.data;
  }

  /** エラーコードの名前（"not_owner" など）。知らないコードは "" */
  get codeName(): string {
    return codeName(this.code);
  }
}

/** 接続が閉じたことで、返事を待っていた要求が終わったときのエラー。 */
export class ConnectionClosedError extends Error {
  constructor(reason?: string) {
    super(reason ? `connection closed: ${reason}` : "connection closed");
    this.name = "ConnectionClosedError";
  }
}

export interface Request {
  jsonrpc: typeof VERSION;
  id: Id;
  method: string;
  params?: unknown;
}

export interface Notification {
  jsonrpc: typeof VERSION;
  method: string;
  params?: unknown;
}

export interface SuccessResponse {
  jsonrpc: typeof VERSION;
  id: Id;
  result: unknown;
}

export interface ErrorResponse {
  jsonrpc: typeof VERSION;
  id: Id | null;
  error: ErrorObject;
}

export type Message = Request | Notification | SuccessResponse | ErrorResponse;

/** 要求（id あり・method あり。返事を求める呼び出し）か。 */
export function isRequest(m: Message): m is Request {
  return "method" in m && "id" in m && m.id != null;
}

/** 通知（id なし・method あり。返事を求めない呼び出し）か。 */
export function isNotification(m: Message): m is Notification {
  return "method" in m && !isRequest(m);
}

/** 応答（method なし。成功でもエラーでも）か。 */
export function isResponse(m: Message): m is SuccessResponse | ErrorResponse {
  return !("method" in m);
}

/** 1 行を読んで Message にする。形が標準に合わなければ Error を投げる。 */
export function parseMessage(line: string): Message {
  const v: unknown = JSON.parse(line);
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("a message must be a JSON object");
  }
  const o = v as Record<string, unknown>;
  if (o.jsonrpc !== VERSION) {
    throw new Error(`jsonrpc must be "${VERSION}"`);
  }
  // id の null は「id が無い」のと同じに揃える（Go 側と同じ）。
  if (o.id === null && "method" in o) {
    delete o.id;
  }
  if (o.id != null && typeof o.id !== "number" && typeof o.id !== "string") {
    throw new Error("id must be a number or a string");
  }
  if ("method" in o) {
    if (typeof o.method !== "string" || o.method === "") {
      throw new Error("method must be a non-empty string");
    }
    return o as unknown as Request | Notification;
  }
  if ("error" in o) {
    const e = o.error as Partial<ErrorObject> | null;
    if (
      typeof e !== "object" ||
      e === null ||
      typeof e.code !== "number" ||
      typeof e.message !== "string"
    ) {
      throw new Error("error must be {code, message}");
    }
    return o as unknown as ErrorResponse;
  }
  if (!("result" in o)) {
    throw new Error("a response must have result or error");
  }
  if (o.id == null) {
    throw new Error("a response must have an id");
  }
  return o as unknown as SuccessResponse;
}
