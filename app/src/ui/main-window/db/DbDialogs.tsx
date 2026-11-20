// DB のタブ（#347）の窓：接続を選ぶ窓と、パスワードを聞く窓。どちらも features/db/controller.ts の状態を出すだけ。
import { Show, type JSX } from "solid-js";

import type { DbTabs } from "../../../features/db/controller.ts";
import { DbConnectionPicker } from "./DbConnectionPicker.tsx";
import { DbPasswordDialog } from "./DbPasswordDialog.tsx";

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
      <Show when={db.passwordAsk()} keyed>
        {(ask) => <DbPasswordDialog ask={ask} onReply={db.replyPassword} />}
      </Show>
    </>
  );
}
