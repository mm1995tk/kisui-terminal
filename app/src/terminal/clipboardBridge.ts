import type { ClipboardItem, Terminal } from "coneko-term";

import {
  planWrite,
  readableMimes,
  supportsLocation,
  type WritePlan,
} from "./clipboard.ts";

/** ターミナルのクリップボードの頼みを受けて答える口（coneko-term の `Terminal` の一部）。 */
export type ClipboardTerm = Pick<
  Terminal,
  | "onClipboardWrite"
  | "onClipboardRead"
  | "replyClipboardWrite"
  | "replyClipboardReadTypes"
  | "replyClipboardReadData"
  | "replyClipboardReadError"
>;

/** OS のクリップボード（clipboardOs.ts）。テストでは差し替える。 */
export interface ClipboardOs {
  write(plan: WritePlan): Promise<void>;
  available(): Promise<string[]>;
  readFirst(mimes: string[]): Promise<ClipboardItem | undefined>;
}

/** 読み取りを許すかをユーザーに聞く（clipboardPrompt.ts の askClipboardRead）。 */
export type AskClipboardRead = (mimes: string[]) => {
  allowed: Promise<boolean>;
  cancel: () => void;
};

/**
 * ターミナルのクリップボードを OS につなぐ。coneko-term は kitty の OSC 5522 と xterm の OSC 52 の
 * どちらも同じイベントにするので、ここでは区別しない。
 * - 書き込みは聞かずに OS へ書く。primary selection は扱えないので対応しない（ENOSYS）と答える。
 * - 読み取りは、読むたびに許すかを聞く。種類の一覧は中身を渡さないので聞かない（OSC 5522 の仕様）。
 * 返す関数で、聞き手を外し、待っている問いを断りとして取り下げる。
 */
export function connectClipboard(
  term: ClipboardTerm,
  os: ClipboardOs,
  ask: AskClipboardRead,
): () => void {
  const pendingReads = new Set<() => void>();
  const write = term.onClipboardWrite((r) => {
    const plan = supportsLocation(r.location) ? planWrite(r.items) : undefined;
    if (!plan) return term.replyClipboardWrite(r.id, "ENOSYS");
    void os.write(plan).then(
      () => term.replyClipboardWrite(r.id),
      () => term.replyClipboardWrite(r.id, "EIO"),
    );
  });
  const read = term.onClipboardRead((r) => {
    if (!supportsLocation(r.location)) {
      return term.replyClipboardReadError(r.id, "ENOSYS");
    }
    if (r.list) {
      void os.available().then(
        (mimes) => term.replyClipboardReadTypes(r.id, mimes),
        () => term.replyClipboardReadError(r.id, "EBUSY"),
      );
      return;
    }
    const q = ask(r.mimes);
    pendingReads.add(q.cancel);
    void (async () => {
      try {
        if (!(await q.allowed)) {
          return term.replyClipboardReadError(r.id, "EPERM");
        }
        const item = await os.readFirst(readableMimes(r.mimes));
        term.replyClipboardReadData(r.id, item ? [item] : []);
      } catch {
        term.replyClipboardReadError(r.id, "EBUSY");
      } finally {
        pendingReads.delete(q.cancel);
      }
    })();
  });
  return () => {
    write.dispose();
    read.dispose();
    pendingReads.forEach((cancel) => cancel());
  };
}
