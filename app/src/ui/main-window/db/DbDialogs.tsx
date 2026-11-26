// DB のタブ（#347）の窓：接続を選ぶ窓・この PC の接続を足す・直す・消す窓（#486）・パスワードを聞く窓・結果の書き出しの窓・履歴の窓（#349）・権限を時間を決めて強める窓（#383）・エージェントの SQL で上書きしてよいかを聞く窓（#382）。どれも features/db/controller.ts の状態を出すだけ。
import { Show, type JSX } from "solid-js";

import type { DbTabs } from "../../../features/db/controller.ts";
import { DbConnectionEditor } from "./DbConnectionEditor.tsx";
import { DbConnectionPicker } from "./DbConnectionPicker.tsx";
import { DbElevateDialog } from "./DbElevateDialog.tsx";
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
            local={db.localDb()}
            localError={db.localDbError()}
            editing={db.connForm() !== null}
            onChoose={db.choose}
            onAdd={db.openConnAdd}
            onEdit={(c) => db.openConnFor("edit", c)}
            onRemove={(c) => db.openConnFor("remove", c)}
            onCancel={db.closePicker}
          />
        )}
      </Show>
      <Show when={db.connForm()}>
        {(f) => (
          <DbConnectionEditor
            form={f()}
            onSubmit={db.submitConnForm}
            onCancel={db.closeConnForm}
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
      <Show when={db.elevateAsk()}>
        {(ask) => (
          <DbElevateDialog
            ask={ask()}
            onSubmit={(actor, duration) =>
              void db.submitElevate(actor, duration)
            }
            onCancel={db.closeElevate}
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
