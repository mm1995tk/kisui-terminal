// `kisui sidebar`・`kisui scale`・`kisui notice`・`kisui mascot`（#517）：Pane の中のコマンドが Window に頼む、Window 全体に効く
// Command（sidebar.toggle・scale・notice.*・mascot.*）。windowRun.ts の受け持ちの表を作る。
// 相手を指す引数は無い（キー操作と同じく Window 全体か、今出しているものに効く）ので、行うことはキー操作の Command と同じ
// runCommand に渡す。キー操作では Notice に出す「できない」は、先に確かめてコマンドに返す。Dialog は開かない
// （mascot.select は、選ぶキャラクターの名前を引数で受ける）。画面にも Tauri にも触らない。
//
// 届く範囲：どれも remote を書かず、手元の PC の Pane の頼みだけを受ける。Window 全体に効き、リモートの Machine の Tab のものでは
// ないので、リモートの Machine に許す理由が無い。そのうえ、人のキーの行き先を変えるもの（sidebar.toggle は Sidebar の中のキーを
// ターミナルに戻す、notice.focusNotified は Pane にキーを向ける）、手元の PC のファイルを開くもの（notice.openDownload）、
// 新しい版を入れて起動し直すもの（notice.update）、手元の設定に書くもの（mascot.select）がある。
import { T } from "../../i18n/index.ts";
import type { Downloads } from "../browser/downloads.ts";
import type { MascotStore } from "../mascot/mascotStore.ts";
import type { ScaleAction } from "../scale/scale.ts";
import { focusLastNotified } from "../terminal/lastNotified.ts";
import type { Updates } from "../updates/store.ts";
import type { Command } from "./commands.ts";
import {
  argString,
  WindowCommandError,
  type WindowCommandTable,
} from "./windowRun.ts";

/** `kisui scale` に渡せる動き。 */
const SCALE_ACTIONS: readonly ScaleAction[] = ["in", "out", "reset"];

/** `kisui mascot list --json` の答え（cmd/kisui/mascot.go の mascotList と同じ形）。 */
export interface MascotListInfo {
  /** 今選んでいるキャラクターの名前。選んでいなければ null */
  current: string | null;
  /** 選べるキャラクター。使えないものは error に理由 */
  entries: { name: string; error: string | null }[];
}

/** Window 全体に効く Command の受け持ちの表を作る。 */
export function createGlobalCommands(deps: {
  /** キー操作と同じ動き（commands/run.ts の runCommand） */
  runCommand(c: Command): void;
  updates: Pick<Updates, "info">;
  downloads: Pick<Downloads, "lastDownload" | "useDownload">;
  mascot: Pick<MascotStore, "choose" | "reloadCurrent" | "list">;
  /** 最後に OS の通知を出した Pane を前に出す（無ければ false。terminal/lastNotified.ts） */
  focusLastNotified?: () => boolean;
}): WindowCommandTable {
  const focusNotified = deps.focusLastNotified ?? focusLastNotified;

  /** キャラクターを替えた・読み直した結果。できなかったら断る。 */
  function failed(f: { title: string; error: string } | undefined) {
    if (f) throw new WindowCommandError(`${f.title}: ${f.error}`);
  }

  return {
    "sidebar.toggle": {
      run: () => {
        deps.runCommand({ id: "sidebar.toggle" });
      },
    },

    scale: {
      run: (args) => {
        const action = argString(args, "action");
        const a = SCALE_ACTIONS.find((x) => x === action);
        if (!a)
          throw new WindowCommandError(
            T("windowRun.err.arg", { name: "action" }),
          );
        deps.runCommand({ id: "scale", arg: a });
      },
    },

    "notice.update": {
      run: () => {
        if (!deps.updates.info())
          throw new WindowCommandError(T("cannot.update.text"));
        deps.runCommand({ id: "notice.update" });
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

    "mascot.list": {
      run: async (): Promise<MascotListInfo> => {
        const l = await deps.mascot.list();
        return {
          current: l.current,
          entries: l.entries.map((e) => ({ name: e.name, error: e.error })),
        };
      },
    },

    "mascot.select": {
      run: async (args) => {
        const name = argString(args, "name").trim();
        if (name === "")
          throw new WindowCommandError(
            T("windowRun.err.arg", { name: "name" }),
          );
        failed(await deps.mascot.choose(name));
        return { name };
      },
    },

    "mascot.reload": {
      run: async () => {
        failed(await deps.mascot.reloadCurrent());
      },
    },
  };
}
