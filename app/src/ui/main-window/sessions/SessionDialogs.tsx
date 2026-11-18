// 接続にかかわる窓。kisui を入れるかの確認・マシンのダイアログ（リーダーの m）・リモートを足す窓・マシンの名前を変える窓・ssh の質問（パスワードなど）。
// 何を出すかは features/sessions/controller.ts の状態で決まる。
import { Show, type JSX } from "solid-js";

import type { Sessions } from "../../../features/sessions/controller.ts";
import type { MachineRow } from "../../../features/sessions/machineList.ts";
import type { SessionState } from "../../../features/sessions/session.ts";
import { RenameDialog } from "../../components/RenameDialog.tsx";
import { AddMachine } from "./AddMachine.tsx";
import { AskpassDialog } from "./AskpassDialog.tsx";
import { InstallCard } from "./InstallCard.tsx";
import { MachineDialog } from "./MachineDialog.tsx";

export function SessionDialogs(props: {
  sessions: Sessions;
  /** マシンのダイアログの行 */
  machineList: () => MachineRow[];
  /** 今のマシン（マシンのダイアログで最初に選ぶ） */
  currentTarget: () => string | undefined;
  /** マシンのダイアログ（リーダーの m）を出しているか */
  machinesOpen: boolean;
  onCloseMachines: () => void;
}): JSX.Element {
  // 部品は作り直さないので、持ち物は 1 回だけ取り出す
  const {
    installing,
    labelOf,
    states,
    sessions,
    disconnect,
    retry,
    removeFromSidebar,
    adding,
    hosts,
    targets,
    addPending,
    addError,
    submitAdd,
    cancelAdd,
    renaming,
    renameError,
    submitRename,
    asks,
    reply,
  } = props.sessions;
  const { machineList, currentTarget } = props;
  return (
    <>
      <Show when={installing()} keyed>
        {(t) => (
          <InstallCard
            target={labelOf(t)}
            state={
              states()[t] as Extract<SessionState, { kind: "needs-install" }>
            }
            onYes={() => void sessions()[t]?.install()}
            onNo={() => sessions()[t]?.declineInstall()}
          />
        )}
      </Show>
      <Show when={props.machinesOpen}>
        <MachineDialog
          rows={machineList()}
          initial={currentTarget() ?? undefined}
          onAdd={() => props.sessions.openAdd()}
          onAct={(action, row) => {
            switch (action) {
              case "rename":
                props.sessions.openRename(row.target);
                break;
              case "remove":
                removeFromSidebar(row.target);
                break;
              case "disconnect":
                void disconnect(row.target);
                break;
              case "reconnect":
                retry(row.target);
                break;
            }
          }}
          onCancel={() => props.onCloseMachines()}
        />
      </Show>
      <Show when={adding()}>
        <AddMachine
          candidates={hosts().filter((h) => !targets().includes(h))}
          busy={addPending() !== null}
          state={addPending() ? states()[addPending()!.target] : undefined}
          error={addError()}
          onSubmit={submitAdd}
          onCancel={cancelAdd}
        />
      </Show>
      <Show when={renaming()} keyed>
        {(t) => (
          <RenameDialog
            current={labelOf(t)}
            fallback={t}
            error={renameError()}
            onSubmit={(name) => submitRename(t, name)}
            onCancel={() => props.sessions.closeRename()}
          />
        )}
      </Show>
      <AskpassDialog ask={asks()[0]} onReply={reply} />
    </>
  );
}
