// `kisui notice`（#517）：Pane の中のコマンドが Window に頼む、Notice の Command（notice.*）。windowRun.ts の受け持ちの表を作る。
// 行うことはキー操作の Command と同じ（update と dismiss は runCommand に渡す）。キー操作では Notice に出す「できない」は、先に確かめて
// コマンドに返す。画面にも Tauri にも触らない。
//
// 届く範囲：どれも remote を書かず、手元の PC の Pane の頼みだけを受ける。人のキーの行き先を変えるもの（notice.focusNotified は
// Pane にキーを向ける）、手元の PC のファイルを開くもの（notice.openDownload）、新しい版を入れて起動し直すもの（notice.update）がある。
import { T } from "../../i18n/index.ts";
import type { Downloads } from "../browser/downloads.ts";
import { focusLastNotified } from "../terminal/lastNotified.ts";
import type { Updates } from "../updates/store.ts";
import type { Command } from "./commands.ts";
import {
  argString,
  WindowCommandError,
  type WindowCommandTable,
} from "./windowRun.ts";

/** Notice の Command の受け持ちの表を作る。 */
export function createNoticeCommands(deps: {
  /** キー操作と同じ動き（commands/run.ts の runCommand） */
  runCommand(c: Command): void;
  updates: Pick<Updates, "checkNow" | "install">;
  downloads: Pick<Downloads, "lastDownload" | "useDownload">;
  /** 最後に OS の通知を出した Pane を前に出す（無ければ false。terminal/lastNotified.ts） */
  focusLastNotified?: () => boolean;
}): WindowCommandTable {
  const focusNotified = deps.focusLastNotified ?? focusLastNotified;

  return {
    "notice.update": {
      // `kisui update` と同じく調べ直してから入れる（キー操作の `i u` と同じ。store.ts の updateNow）。新しい版が無いことは
      // コマンドに返す。入れ替えは待たない（うまくいけば起動し直して戻らない）
      run: async () => {
        const r = await deps.updates.checkNow();
        if (r.status === "failed")
          throw new WindowCommandError(
            T("cannot.update.checkFailed", { error: r.error }),
          );
        if (r.status !== "available")
          throw new WindowCommandError(T("cannot.update.text"));
        void deps.updates.install();
      },
    },

    "notice.dismiss": {
      run: () => {
        deps.runCommand({ id: "notice.dismiss" });
      },
    },

    "notice.focusNotified": {
      run: () => {
        if (!focusNotified())
          throw new WindowCommandError(T("globalCli.err.noNotified"));
      },
    },

    // 開くファイルの名前を引数で受け、最後のダウンロードの名前と同じときだけ開く。内蔵ブラウザのページは、開けば動くファイル
    // （.command など）を、聞かれずにいつでも「最後のダウンロード」にできる。キー操作なら人が Notice の名前を見てから開くが、
    // CLI では、頼んだ側が思っているのと違うファイルが開くことがあるので
    "notice.openDownload": {
      run: async (args) => {
        const name = argString(args, "name");
        const d = deps.downloads.lastDownload();
        if (!d) throw new WindowCommandError(T("cannot.download.text"));
        if (d.name !== name)
          throw new WindowCommandError(
            T("globalCli.err.otherDownload", { name, last: d.name }),
          );
        if (!(await deps.downloads.useDownload(d, "open")))
          throw new WindowCommandError(
            T("err.download.open", { name: d.name }),
          );
        return { name: d.name };
      },
    },

    "notice.revealDownload": {
      run: async () => {
        const d = deps.downloads.lastDownload();
        if (!d) throw new WindowCommandError(T("cannot.download.text"));
        if (!(await deps.downloads.useDownload(d, "reveal")))
          throw new WindowCommandError(
            T("err.download.reveal", { name: d.name }),
          );
        return { name: d.name };
      },
    },
  };
}
