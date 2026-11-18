// ターミナルのファイル転送（kitty の file transfer protocol、OSC 5113）を OS につなぐ。
// coneko-term が出すイベント（FileTransferEvent）を受け、ユーザーに聞き、手元のファイルの読み書き（Rust 側、transfer.rs）を
// 呼んで、答えを coneko-term に返す。ここは画面の欄ごとに 1 つ作る（createTransfer）。
//
// 信頼の決まり（ssh 先のプログラムが手元のファイルに触れるので）:
// - 送る・受け取るの頼みは、そのたびにユーザーに聞く。覚えない。パスワードによる確認の省略（bypass）は聞かずに通す形には使わない。
// - 書くのは、聞いた 1 つのディレクトリの中だけ（Rust 側が守る）。リンクは作らない。同じ名前のファイルは上書きしない。
// - 読むのは、ユーザーに見せて許した一覧の中のファイルだけ（Rust 側が守る）。
// - 圧縮（zlib）はここで読み解く・かける。rsync の差分は扱わない（仕様の形で断る）。
import type {
  FileTransferErrorName,
  FileTransferEvent,
  FileTransferFileType,
  FileTransferListing,
} from "coneko-term";

import type { ReadItem, TransferInfo } from "./transferPrompt.ts";

/** Rust 側が並べた 1 項目。 */
export interface ListEntry {
  requestId: string;
  entryId: string;
  name: string;
  fileType: FileTransferFileType;
  /** 更新時刻（ナノ秒、10 進の文字列） */
  mtime: string | null;
  permissions: number | null;
  size: number | null;
  parent: string | null;
  /** シンボリックリンクの先 */
  data: string | null;
}

/** Rust 側（transfer_read_list）が並べた結果。許可の窓に見せ、許されたら相手に返す。 */
export interface Listing {
  entries: ListEntry[];
  errors: { requestId: string; code: string; message: string }[];
  home: string;
  totalSize: number;
}

/** 手元のファイルの読み書き（Rust 側。transferOs.ts）。失敗は `code`（記号名）を持つ Error で投げる。 */
export interface TransferOs {
  dest(): Promise<string>;
  writeBegin(key: string): Promise<string>;
  writeOpen(
    key: string,
    open: {
      fileId: string;
      name: string;
      directory: boolean;
      permissions: number | null;
      mtime: string | null;
      limit: number;
    },
  ): Promise<string>;
  writeChunk(key: string, fileId: string, bytes: Uint8Array): Promise<number>;
  writeEnd(key: string, fileId: string): Promise<number>;
  writeClose(key: string, keepDone: boolean): Promise<void>;
  readList(
    key: string,
    requests: { fileId: string; name: string }[],
  ): Promise<Listing>;
  readApprove(key: string): Promise<void>;
  readOpen(key: string, entryId: string): Promise<number>;
  readNext(key: string, entryId: string, len: number): Promise<Uint8Array>;
  readClose(key: string): Promise<void>;
}

/** coneko-term の Terminal のうち、答えを返す口。 */
export interface TransferReplies {
  replyFileTransferOk(
    id: string,
    opts?: { fileId?: string; size?: number; name?: string },
  ): void;
  replyFileTransferStarted(id: string, fileId: string, rsync?: boolean): void;
  replyFileTransferProgress(id: string, fileId: string, written: number): void;
  replyFileTransferError(
    id: string,
    error: FileTransferErrorName,
    opts?: { fileId?: string; message?: string },
  ): void;
  refuseFileTransfer(id: string): void;
  replyFileTransferCanceled(id: string): void;
  replyFileTransferListing(id: string, entry: FileTransferListing): void;
  replyFileTransferData(
    id: string,
    fileId: string,
    data: Uint8Array,
    end?: boolean,
  ): void;
}

/** 許可の窓を出して答えを待つ関数（transferPrompt.ts の askTransfer）。cancel で取り下げる。 */
export type AskTransfer = (info: TransferInfo) => {
  allowed: Promise<boolean>;
  cancel: () => void;
};

/** 欄ごとに同時に持つセッションの数の上限。 */
export const MAX_SESSIONS = 4;
/** 受け取りの頼みで受け付けるパスの数の上限。 */
const MAX_PATHS = 64;
/** 許可の画面に並べる項目の数。 */
export const SHOWN_ITEMS = 12;
/** 大きさが分からないファイルを書くときの上限（バイト）。 */
const DEFAULT_LIMIT = 2 * 1024 ** 3;
/** 手元のファイルを読んで送るときの 1 回の大きさ。 */
const READ_CHUNK = 256 * 1024;

const CODES: readonly FileTransferErrorName[] = [
  "EPERM",
  "ENOENT",
  "EEXIST",
  "EISDIR",
  "ENOTDIR",
  "EACCES",
  "EINVAL",
  "EIO",
  "EFBIG",
  "ENOSPC",
];

/** 投げられたものを、答えに使う記号名と理由にする。 */
export function toError(e: unknown): {
  code: FileTransferErrorName;
  message: string;
} {
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : String(e);
  return {
    code: CODES.find((c) => c === code) ?? "EIO",
    message,
  };
}

/** 記号名に対する、固定の説明（OS の文を外に出さないため）。 */
function errorText(code: string): string {
  return code === "ENOENT" ? "Does not exist" : "Cannot be read";
}

/** 大きさを読みやすくする（1024 区切り）。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** 並べた一覧を、許可の画面に見せる形にする。 */
export function readInfo(list: Listing): TransferInfo {
  const kinds = new Set(["regular", "directory", "symlink"]);
  const all: ReadItem[] = list.entries
    .filter((e) => kinds.has(e.fileType))
    .map((e) => ({
      path: e.name,
      kind: e.fileType as ReadItem["kind"],
      size: e.size ?? undefined,
    }));
  return {
    direction: "read",
    items: all.slice(0, SHOWN_ITEMS),
    more: Math.max(0, all.length - SHOWN_ITEMS),
    files: all.filter((i) => i.kind === "regular").length,
    totalSize: list.totalSize,
  };
}

/** zlib（RFC 1950）の圧縮・展開の流れ。出てきたものは onData に順に渡す。 */
class Pipe {
  private readonly writer: WritableStreamDefaultWriter<BufferSource>;
  private readonly pump: Promise<void>;
  private failure: unknown;

  constructor(
    stream: {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<BufferSource>;
    },
    onData: (chunk: Uint8Array) => Promise<void>,
  ) {
    const writer = stream.writable.getWriter();
    this.writer = writer;
    const reader = stream.readable.getReader();
    this.pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          await onData(value);
        }
      } catch (e) {
        this.failure = e;
        // 書く側が待ち続けないよう、流れを止める
        await writer.abort(e).catch(() => undefined);
        await reader.cancel(e).catch(() => undefined);
      }
    })();
  }

  async write(chunk: Uint8Array): Promise<void> {
    try {
      await this.writer.write(chunk as Uint8Array<ArrayBuffer>);
    } catch (e) {
      await this.pump;
      throw this.failure ?? e;
    }
  }

  async close(): Promise<void> {
    try {
      await this.writer.close();
    } catch (e) {
      await this.pump;
      throw this.failure ?? e;
    }
    await this.pump;
    if (this.failure) throw this.failure;
  }

  async abort(): Promise<void> {
    await this.writer.abort().catch(() => undefined);
    await this.pump;
  }
}

const inflater = (onData: (c: Uint8Array) => Promise<void>) =>
  new Pipe(new DecompressionStream("deflate"), onData);
const deflater = (onData: (c: Uint8Array) => Promise<void>) =>
  new Pipe(new CompressionStream("deflate"), onData);

interface WriteFile {
  limit: number;
  /** Rust 側が書いた大きさ */
  written: number;
  pipe: Pipe | undefined;
  failed: boolean;
}

interface Session {
  kind: "write" | "read";
  key: string;
  /** 受けた順に 1 つずつ処理する */
  chain: Promise<void>;
  cancelled: boolean;
  cancelAsk: (() => void) | undefined;
  // 書く側
  files: Map<string, WriteFile>;
  // 読む側
  expected: number;
  requests: { fileId: string; name: string }[];
  entries: Map<string, ListEntry>;
  listed: boolean;
}

/** 欄ごとの転送の入り口。TerminalView が coneko-term のイベントを渡す。 */
export interface Transfer {
  /** coneko-term の onFileTransfer に渡す */
  handle(e: FileTransferEvent): void;
  /** 欄を閉じる。聞いている最中のものは断り、途中のファイルは消す */
  dispose(): void;
}

/** 欄ごとの転送。`prefix` は、欄どうしでセッションの id が重なっても Rust 側で混ざらないようにする印。 */
export function createTransfer(
  term: TransferReplies,
  os: TransferOs,
  ask: AskTransfer,
  prefix: string,
): Transfer {
  const sessions = new Map<string, Session>();

  const finish = (id: string, s: Session, keepDone: boolean) => {
    if (sessions.get(id) === s) sessions.delete(id);
    s.cancelAsk?.();
    for (const f of s.files.values()) void f.pipe?.abort();
    void (
      s.kind === "write" ? os.writeClose(s.key, keepDone) : os.readClose(s.key)
    ).catch(() => undefined);
  };

  const fail = (
    id: string,
    e: unknown,
    fileId?: string,
  ): FileTransferErrorName => {
    const { code, message } = toError(e);
    term.replyFileTransferError(id, code, { fileId, message });
    return code;
  };

  /** 聞く。取り消されたら false。 */
  const confirm = async (s: Session, info: TransferInfo) => {
    const a = ask(info);
    s.cancelAsk = a.cancel;
    try {
      return (await a.allowed) && !s.cancelled;
    } finally {
      s.cancelAsk = undefined;
    }
  };

  // ---- 書く（プログラム → 手元） ----

  async function startWrite(id: string, s: Session) {
    let destination: string;
    try {
      destination = await os.dest();
    } catch {
      return refuse(id, s);
    }
    if (!(await confirm(s, { direction: "write", destination }))) {
      if (!s.cancelled) refuse(id, s);
      return;
    }
    try {
      await os.writeBegin(s.key);
    } catch (e) {
      fail(id, e);
      finish(id, s, false);
      return;
    }
    term.replyFileTransferOk(id);
  }

  function refuse(id: string, s: Session) {
    term.refuseFileTransfer(id);
    finish(id, s, false);
  }

  async function writeFile(
    id: string,
    s: Session,
    e: Extract<FileTransferEvent, { type: "file" }>,
  ) {
    const { fileId } = e;
    if (e.fileType === "symlink" || e.fileType === "link") {
      // リンクは作らない（リンクの先を作る・書き換える経路になるため）
      fail(id, { code: "EPERM", message: "links are not supported" }, fileId);
      return;
    }
    const directory = e.fileType === "directory";
    const limit = e.size ?? DEFAULT_LIMIT;
    try {
      await os.writeOpen(s.key, {
        fileId,
        name: e.name,
        directory,
        permissions: e.permissions,
        mtime: e.mtime === null ? null : e.mtime.toString(),
        limit,
      });
    } catch (err) {
      fail(id, err, fileId);
      return;
    }
    if (directory) return void term.replyFileTransferOk(id, { fileId });
    const f: WriteFile = { limit, written: 0, pipe: undefined, failed: false };
    s.files.set(fileId, f);
    if (e.compression === "zlib") {
      f.pipe = inflater(async (chunk) => {
        f.written = await os.writeChunk(s.key, fileId, chunk);
      });
    }
    // rsync の差分は扱わない。rsync を付けずに答えると、クライアントはファイルを丸ごと送る
    term.replyFileTransferStarted(id, fileId, false);
  }

  async function writeData(
    id: string,
    s: Session,
    e: Extract<FileTransferEvent, { type: "data" }>,
  ) {
    // STARTED の前や、失敗したあとのデータは捨てる（仕様）
    const f = s.files.get(e.fileId);
    if (!f || f.failed) return;
    try {
      if (f.pipe) await f.pipe.write(e.data);
      else f.written = await os.writeChunk(s.key, e.fileId, e.data);
      if (e.end) {
        await f.pipe?.close();
        const size = await os.writeEnd(s.key, e.fileId);
        s.files.delete(e.fileId);
        term.replyFileTransferOk(id, { fileId: e.fileId, size });
      } else {
        term.replyFileTransferProgress(id, e.fileId, f.written);
      }
    } catch (err) {
      f.failed = true;
      fail(id, err, e.fileId);
    }
  }

  // ---- 読む（手元 → プログラム） ----

  async function listAndAsk(id: string, s: Session) {
    let list: Listing;
    try {
      list = await os.readList(s.key, s.requests);
    } catch (e) {
      fail(id, e);
      finish(id, s, false);
      return;
    }
    if (list.entries.length === 0) {
      // 見つからない・読めないという答えは、ユーザーに聞かずには返さない（手元のファイルの有無や権限を外に出さない）。
      // 聞く中身が無いので、断りとして答える
      return refuse(id, s);
    }
    if (!(await confirm(s, readInfo(list)))) {
      if (!s.cancelled) refuse(id, s);
      return;
    }
    try {
      await os.readApprove(s.key);
    } catch (e) {
      fail(id, e);
      finish(id, s, false);
      return;
    }
    // 許されたあとでも、返すのは記号名だけ。OS の文は外に出さない
    for (const er of list.errors) {
      fail(id, { code: er.code, message: errorText(er.code) }, er.requestId);
    }
    const enc = new TextEncoder();
    for (const en of list.entries) {
      s.entries.set(en.entryId, en);
      term.replyFileTransferListing(id, {
        requestId: en.requestId,
        entryId: en.entryId,
        name: en.name,
        fileType: en.fileType,
        ...(en.mtime === null ? {} : { mtime: BigInt(en.mtime) }),
        ...(en.permissions === null ? {} : { permissions: en.permissions }),
        ...(en.size === null ? {} : { size: en.size }),
        ...(en.parent === null ? {} : { parent: en.parent }),
        ...(en.data === null ? {} : { data: enc.encode(en.data) }),
      });
    }
    s.listed = true;
    term.replyFileTransferOk(id, { name: list.home });
  }

  async function readFile(
    id: string,
    s: Session,
    e: Extract<FileTransferEvent, { type: "file" }>,
  ) {
    const { fileId } = e;
    const entry = s.entries.get(fileId);
    // 許した一覧に無いものは読まない
    if (!entry || entry.fileType !== "regular") {
      fail(id, { code: "EPERM", message: "not in the approved list" }, fileId);
      return;
    }
    if (e.transmission === "rsync") {
      fail(id, { code: "EINVAL", message: "rsync is not supported" }, fileId);
      return;
    }
    try {
      await os.readOpen(s.key, fileId);
      const send = async (chunk: Uint8Array) =>
        term.replyFileTransferData(id, fileId, chunk, false);
      const pipe = e.compression === "zlib" ? deflater(send) : undefined;
      for (;;) {
        if (s.cancelled) {
          await pipe?.abort();
          return;
        }
        const chunk = await os.readNext(s.key, fileId, READ_CHUNK);
        if (chunk.length === 0) break;
        if (pipe) await pipe.write(chunk);
        else await send(chunk);
        // 画面や、ほかの欄を止めないよう、1 回ごとに譲る
        await new Promise((r) => setTimeout(r, 0));
      }
      await pipe?.close();
      term.replyFileTransferData(id, fileId, new Uint8Array(), true);
    } catch (err) {
      fail(id, err, fileId);
    }
  }

  // ---- 受けたイベントの振り分け ----

  async function step(id: string, s: Session, e: FileTransferEvent) {
    if (s.cancelled || sessions.get(id) !== s) return;
    switch (e.type) {
      case "send":
        return startWrite(id, s);
      case "receive":
        // 頼むパスの数が分からないものや多すぎるものは断る
        if (e.paths === null || e.paths < 1 || e.paths > MAX_PATHS) {
          return refuse(id, s);
        }
        s.expected = e.paths;
        return;
      case "file":
        if (s.kind === "write") return writeFile(id, s, e);
        if (!s.listed) {
          if (s.requests.length >= s.expected) return;
          s.requests.push({ fileId: e.fileId, name: e.name });
          if (s.requests.length === s.expected) return listAndAsk(id, s);
          return;
        }
        return readFile(id, s, e);
      case "data":
        // 書く側のデータだけ。読む側の rsync の署名は扱わない
        if (s.kind === "write") return writeData(id, s, e);
        return;
      case "finish":
        finish(id, s, true);
        return;
      case "cancel":
        return;
    }
  }

  return {
    handle(e) {
      if (e.type === "send" || e.type === "receive") {
        const old = sessions.get(e.id);
        // 同じ id の始まりをもう一度受けたら、前のものを捨てる（仕様）
        if (old) {
          old.cancelled = true;
          finish(e.id, old, false);
        }
        if (sessions.size >= MAX_SESSIONS) {
          term.refuseFileTransfer(e.id);
          return;
        }
        const s: Session = {
          kind: e.type === "send" ? "write" : "read",
          key: `${prefix}:${e.id}`,
          chain: Promise.resolve(),
          cancelled: false,
          cancelAsk: undefined,
          files: new Map(),
          expected: 0,
          requests: [],
          entries: new Map(),
          listed: false,
        };
        sessions.set(e.id, s);
      }
      const s = sessions.get(e.id);
      // 知らないセッションへの命令は捨てる
      if (!s) return;
      if (e.type === "cancel") {
        // 聞いている最中でも、すぐ取り下げる
        s.cancelled = true;
        s.cancelAsk?.();
        const id = e.id;
        s.chain = s.chain.then(() => {
          finish(id, s, false);
          term.replyFileTransferCanceled(id);
        });
        return;
      }
      const id = e.id;
      s.chain = s.chain
        .then(() => step(id, s, e))
        .catch((err) => {
          // 予期しない失敗でも、セッションを閉じて断る
          fail(id, err);
          finish(id, s, false);
        });
    },
    dispose() {
      for (const [id, s] of [...sessions]) {
        s.cancelled = true;
        finish(id, s, true);
      }
    },
  };
}
