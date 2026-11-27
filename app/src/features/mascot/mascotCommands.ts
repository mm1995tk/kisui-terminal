// `kisui mascot`（#517）：Pane の中のコマンドが Window に頼む、キャラクターの Command（mascot.select・mascot.reload と、一覧）。
// windowRun.ts の受け持ちの表を作る。行うことはキー操作と同じ（mascotStore.ts）で、mascot.select は Dialog を開かず、選ぶ
// キャラクターの名前を引数で受ける。画面にも Tauri にも触らない。
//
// 届く範囲：どれも remote を書かず、手元の PC の Pane の頼みだけを受ける（mascot.select は手元の設定 config.local.toml に書く）。
import { T } from "../../i18n/index.ts";
import {
  argString,
  WindowCommandError,
  type WindowCommandTable,
} from "../commands/windowRun.ts";
import type { MascotStore } from "./mascotStore.ts";

/** `kisui mascot list --json` の答え（cmd/kisui/global.go の mascotList と同じ形）。 */
export interface MascotListInfo {
  /** 今選んでいるキャラクターの名前。選んでいなければ null */
  current: string | null;
  /** 選べるキャラクター。使えないものは error に理由 */
  entries: { name: string; error: string | null }[];
}

/** キャラクターの Command の受け持ちの表を作る。 */
export function createMascotCommands(deps: {
  mascot: Pick<MascotStore, "choose" | "reloadCurrent" | "list">;
}): WindowCommandTable {
  /** キャラクターを替えた・読み直した結果。できなかったら断る。 */
  function failed(f: { title: string; error: string } | undefined) {
    if (f) throw new WindowCommandError(`${f.title}: ${f.error}`);
  }

  return {
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
