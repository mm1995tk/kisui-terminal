// 接続にかかわる窓。kisui を入れるかの確認・マシンのダイアログ（リーダーの m。マシンの名前は、この中の行で変える。Enter でワークスペースの窓のタブ作成へ）・リモートを足す窓・
// マシンのターミナルの始め方（始めるフォルダとシェル）を変える窓・ssh の質問（パスワードなど）。
// 何を出すかは features/sessions/controller.ts の状態で決まる。
import { createSignal, Show, type JSX } from "solid-js";

import type { Sessions } from "../../../features/sessions/controller.ts";
import type { MachineRow } from "../../../features/sessions/machineList.ts";
import type { SessionState } from "../../../features/sessions/session.ts";
import { AddMachine } from "./AddMachine.tsx";
import { AskpassDialog } from "./AskpassDialog.tsx";
import { InstallCard } from "./InstallCard.tsx";
import { MachineDialog } from "./MachineDialog.tsx";
import { PaneApprovalDialog } from "./PaneApprovalDialog.tsx";
import { PaneGrantDialog } from "./PaneGrantDialog.tsx";
import {
  endPaneGrant,
  grantPanes,
} from "../../../features/sessions/paneGrant.ts";
import { TerminalSettings } from "./TerminalSettings.tsx";

/** 接続にかかわる窓をまとめて出す。出していない窓は何も描かない。 */
export function SessionDialogs(props: {
  sessions: Sessions;
  /** マシンのダイアログの行 */
  machineList: () => MachineRow[];
  /** 今のマシン（マシンのダイアログで最初に選ぶ） */
  currentTarget: () => string | undefined;
  /** マシンのダイアログ（リーダーの m）を出しているか */
  machinesOpen: boolean;
  onCloseMachines: () => void;
  /** 今のワークスペースがあるか（マシンのダイアログの Enter で、タブ作成を始められるか） */
  hasWorkspace: () => boolean;
  /** マシンのダイアログの Enter：マシン target を設定したターミナルのタブ作成を、ワークスペースの窓で始める（マシンのダイアログを閉じるのも呼んだ側） */
  onNewTab: (target: string) => void;
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
    termEditing,
    termEditError,
    termEditBusy,
    submitTermEdit,
    closeTermEdit,
    asks,
    askMachine,
    reply,
  } = props.sessions;
  const { machineList, currentTarget } = props;
  // 手元の PC のペインの操作を、時間を決めて許す窓を出しているマシン（マシンのダイアログの p。無ければ null）
  const [granting, setGranting] = createSignal<string | null>(null);
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
          hasWorkspace={props.hasWorkspace()}
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
              case "terminal":
                props.sessions.closeRename();
                void props.sessions.openTermEdit(row.target);
                break;
              case "newTab":
                props.sessions.closeRename();
                props.onNewTab(row.target);
                break;
              case "grant":
                props.sessions.closeRename();
                setGranting(row.target);
                break;
              case "grantEnd":
                endPaneGrant(row.target);
                break;
            }
          }}
          renaming={
            renaming() ? { target: renaming()!, error: renameError() } : null
          }
          onRenameSubmit={submitRename}
          onRenameCancel={() => props.sessions.closeRename()}
          onCancel={() => {
            props.sessions.closeRename();
            props.onCloseMachines();
          }}
        />
      </Show>
      <Show when={termEditing()} keyed>
        {(editing) => (
          <TerminalSettings
            machine={labelOf(editing.target)}
            values={editing.values}
            busy={termEditBusy()}
            error={termEditError()}
            onSubmit={submitTermEdit}
            onCancel={closeTermEdit}
          />
        )}
      </Show>
      <Show when={granting()} keyed>
        {(target) => (
          <PaneGrantDialog
            machine={labelOf(target)}
            onSubmit={(seconds) => {
              grantPanes(target, seconds);
              setGranting(null);
            }}
            onCancel={() => setGranting(null)}
          />
        )}
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
      <AskpassDialog ask={asks()[0]} machineOf={askMachine} onReply={reply} />
      <PaneApprovalDialog machineOf={labelOf} />
    </>
  );
}
