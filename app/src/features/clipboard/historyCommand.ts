// `kisui clipboard history`（#517）：Pane の中のコマンドが Window に頼む、クリップボードの履歴（clipboard.history）。
// commands/windowRun.ts の受け持ちの表を作る。キー操作の clipboard.history は履歴の Dialog を開くが、CLI は履歴をそのまま返す。
// 画面にも Tauri にも触らない。
//
// 履歴には、前にコピーしたもの（パスワードなど）が残っているので、`kisui clipboard paste` と同じく、読むたびに Window で人に聞き、
// 答えを覚えない（clipboardPrompt.ts の askClipboardHistory）。そのうえ remote を書かず、手元の PC の Pane の頼みだけを受ける：
// 今のクリップボード 1 つ（paste）より多くのものが出るので、リモートの Machine の Pane には、聞いたうえでも読ませない。
import { T } from "../../i18n/index.ts";
import {
  WindowCommandError,
  type WindowCommandTable,
} from "../commands/windowRun.ts";
import type { HistoryEntry, ListClipboardHistory } from "./history.ts";

/** 読むたびに、読ませてよいかを人に聞く（本物は clipboardPrompt.ts の askClipboardHistory）。 */
export type AskClipboardHistory = () => {
  allowed: Promise<boolean>;
  cancel: () => void;
};

/** `kisui clipboard history` の受け持ちの表を作る。 */
export function createClipboardCommands(deps: {
  list: ListClipboardHistory;
  ask: AskClipboardHistory;
}): WindowCommandTable {
  return {
    "clipboard.history": {
      run: async (_args, c): Promise<{ entries: HistoryEntry[] }> => {
        const q = deps.ask();
        // serve が待つのをやめたら、聞くのをやめる（断りとして取り下げる）
        const stop = () => q.cancel();
        c.signal.addEventListener("abort", stop);
        let allowed: boolean;
        try {
          allowed = await q.allowed;
        } finally {
          c.signal.removeEventListener("abort", stop);
        }
        if (!allowed)
          throw new WindowCommandError(T("clipboardCli.err.denied"));
        const entries = await deps.list();
        return {
          entries: entries.map((e) => ({ text: e.text, copiedAt: e.copiedAt })),
        };
      },
    },
  };
}
