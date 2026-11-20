// DB のタブ（#347）の窓：接続を選ぶ窓・パスワードを聞く窓・結果の書き出しの窓・履歴の窓（#349）・エージェントの SQL で上書きしてよいかを聞く窓（#382）。どれも features/db/controller.ts の状態を出すだけ。
import { Show, type JSX } from "solid-js";

import type { DbTabs } from "../../../features/db/controller.ts";
import { DbConnectionPicker } from "./DbConnectionPicker.tsx";
import { DbExportDialog } from "./DbExportDialog.tsx";
import { DbHistoryDialog } from "./DbHistoryDialog.tsx";
import { DbPasswordDialog } from "./DbPasswordDialog.tsx";
import { DbProposeDialog } from "./DbProposeDialog.tsx";

/** DB のタブの窓を、出しているときだけ出す。 */
export function DbDialogs(props: { db: DbTabs }): JSX.Element {
  const db = props.db;
  return (
    <>
      <Show when={db.picker()}>
        {(p) => (
          <DbConnectionPicker
            picker={p()}
            onChoose={db.choose}
            onCancel={db.closePicker}
          />
        )}
      </Show>
      <Show when={db.exportAsk()}>
        {(ask) => (
          <DbExportDialog
            ask={ask()}
            onChoose={(c) => void db.chooseExport(c)}
            onCancel={db.closeExport}
          />
        )}
      </Show>
      <Show when={db.historyAsk()}>
        {(ask) => (
          <DbHistoryDialog
            ask={ask()}
            onChoose={db.chooseHistory}
            onCancel={db.closeHistory}
          />
        )}
      </Show>
      <Show when={db.proposeAsk()} keyed>
        {(ask) => <DbProposeDialog ask={ask} onReply={db.replyPropose} />}
      </Show>
      <Show when={db.passwordAsk()} keyed>
        {(ask) => <DbPasswordDialog ask={ask} onReply={db.replyPassword} />}
      </Show>
    </>
  );
}
