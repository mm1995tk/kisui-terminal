// `kisui sidebar`・`kisui scale`（#517）：Pane の中のコマンドが Window に頼む、Window 全体の見た目の Command（sidebar.toggle・scale）。
// windowRun.ts の受け持ちの表を作る。Notice の Command は noticeCommands.ts、キャラクターは mascot/mascotCommands.ts。
// 相手を指す引数は無い（キー操作と同じく Window 全体か、今出しているものに効く）ので、行うことはキー操作の Command と同じ
// runCommand に渡す。画面にも Tauri にも触らない。
//
// 届く範囲：remote を書かず、手元の PC の Pane の頼みだけを受ける。Window 全体に効き、リモートの Machine の Tab のものでは
// ないので、リモートの Machine に許す理由が無い。そのうえ sidebar.toggle は、Sidebar の中のキーをターミナルに戻す（人のキーの
// 行き先を変える）。
import { T } from "../../i18n/index.ts";
import type { ScaleAction } from "../scale/scale.ts";
import type { Command } from "./commands.ts";
import {
  argString,
  WindowCommandError,
  type WindowCommandTable,
} from "./windowRun.ts";

/** `kisui scale` に渡せる動き。 */
const SCALE_ACTIONS: readonly ScaleAction[] = ["in", "out", "reset"];

/** Window 全体の見た目の Command の受け持ちの表を作る。 */
export function createGlobalCommands(deps: {
  /** キー操作と同じ動き（commands/run.ts の runCommand） */
  runCommand(c: Command): void;
}): WindowCommandTable {
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
  };
}
