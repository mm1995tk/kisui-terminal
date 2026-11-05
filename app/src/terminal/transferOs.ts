import { invoke } from "@tauri-apps/api/core";

import type { ListEntry, Listing, TransferOs } from "./transfer.ts";

/** Rust 側（transfer.rs）のエラーは `ENOENT:理由` の形。記号名と理由に分ける。 */
export class TransferError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function call<T>(
  cmd: string,
  args?: Record<string, unknown> | Uint8Array,
  options?: { headers: Record<string, string> },
): Promise<T> {
  try {
    return (await invoke(cmd, args, options)) as T;
  } catch (e) {
    const s = typeof e === "string" ? e : String(e);
    const i = s.indexOf(":");
    const code =
      i > 0 && /^E[A-Z]+$/.test(s.slice(0, i)) ? s.slice(0, i) : "EIO";
    throw new TransferError(code, i > 0 ? s.slice(i + 1) : s);
  }
}

/** ファイルの読み書きは Rust 側（transfer.rs）がする。ここは呼ぶだけ。 */
export const tauriTransferOs: TransferOs = {
  dest: () => call<string>("transfer_dest"),
  writeBegin: (key) => call<string>("transfer_write_begin", { key }),
  writeOpen: (key, open) => call<string>("transfer_write_open", { key, open }),
  writeChunk: (key, fileId, bytes) =>
    call<number>("transfer_write_chunk", bytes, {
      headers: { "x-key": key, "x-file": fileId },
    }),
  writeEnd: (key, fileId) =>
    call<number>("transfer_write_end", { key, fileId }),
  writeClose: (key, keepDone) =>
    call<void>("transfer_write_close", { key, keepDone }),
  readList: (key, requests) =>
    call<Listing>("transfer_read_list", { key, requests }),
  readApprove: (key) => call<void>("transfer_read_approve", { key }),
  readOpen: (key, entryId) =>
    call<number>("transfer_read_open", { key, entryId }),
  readNext: async (key, entryId, len) =>
    new Uint8Array(
      await call<ArrayBuffer>("transfer_read_next", { key, entryId, len }),
    ),
  readClose: (key) => call<void>("transfer_read_close", { key }),
};

export type { ListEntry };
