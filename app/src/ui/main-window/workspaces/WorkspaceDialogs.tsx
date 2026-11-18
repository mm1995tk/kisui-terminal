// ワークスペースとタブにかかわる窓。閉じる前の確認・ワークスペースを切り替える窓（リーダーの w）・種類を選ぶ窓・マシンを選ぶ窓。
// タブの名前は窓を出さず、サイドバーのタブの行で変える（sidebar/workspaces/TabRow.tsx）。
// 何を出すかは features/workspaces/controller.ts と features/workspaces/tabs/controller.ts の状態で決まる。
import { Show, type JSX } from "solid-js";

import type { Workspaces } from "../../../features/workspaces/controller.ts";
import type { Tabs } from "../../../features/workspaces/tabs/controller.ts";
import { MachinePicker } from "../sessions/MachinePicker.tsx";
import { CloseWorkspaceCard } from "./CloseWorkspaceCard.tsx";
import { WorkspaceKindPicker } from "./WorkspaceKindPicker.tsx";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.tsx";

/** ワークスペースとタブにかかわる窓をまとめて出す。出していない窓は何も描かない。 */
export function WorkspaceDialogs(props: {
  workspaces: Workspaces;
  tabs: Tabs;
  /** ワークスペースを切り替える窓（リーダーの w）を出しているか */
  switcherOpen: boolean;
  onCloseSwitcher: () => void;
}): JSX.Element {
  // 部品は作り直さないので、持ち物は 1 回だけ取り出す
  const {
    confirmClose,
    cancelClose,
    closeWorkspace,
    rows,
    goRow,
    reorder,
    dropBefore,
    newWorkspace,
    renameInit,
    renameWorkspace,
    pickingKind,
    closeKindPicker,
    createBrowserWorkspace,
    newTerminalWorkspace,
    pickingMachine,
    closeMachinePicker,
    creatable,
    currentTarget,
    createWorkspace,
    gws,
  } = props.workspaces;
  const {
    selectTab,
    pickingFor,
    closeTabMachinePicker,
    newTerminalTab,
    confirmCloseTab,
    cancelCloseTab,
    closeTermTab,
  } = props.tabs;
  const closeSwitcher = () => props.onCloseSwitcher();
  return (
    <>
      <Show when={confirmClose()} keyed>
        {(c) => (
          <CloseWorkspaceCard
            name={c.name}
            onYes={() => {
              // <Show keyed> の c は値そのものなので、窓を閉じたあとに読んでよい（#162・#272）
              cancelClose();
              void closeWorkspace(c.gws, true);
            }}
            onNo={cancelClose}
          />
        )}
      </Show>
      <Show when={props.switcherOpen}>
        <WorkspaceSwitcher
          rows={rows()}
          onGo={(r) => {
            closeSwitcher();
            goRow(r);
          }}
          onTab={(gid, key) => {
            closeSwitcher();
            selectTab(gid, key);
          }}
          onReorder={reorder}
          onDrop={dropBefore}
          onNew={() => {
            closeSwitcher();
            newWorkspace();
          }}
          renameInit={renameInit}
          onRename={renameWorkspace}
          onClose={(gid) => void closeWorkspace(gid)}
          onCancel={closeSwitcher}
        />
      </Show>
      <Show when={pickingKind()}>
        <WorkspaceKindPicker
          onChoose={(kind) => {
            closeKindPicker();
            if (kind === "browser") createBrowserWorkspace();
            else newTerminalWorkspace();
          }}
          onCancel={closeKindPicker}
        />
      </Show>
      <Show when={pickingMachine()}>
        <MachinePicker
          rows={creatable()}
          initial={currentTarget()}
          onChoose={(t) => {
            closeMachinePicker();
            void createWorkspace(t);
          }}
          onCancel={closeMachinePicker}
        />
      </Show>
      <Show when={pickingFor()} keyed>
        {(gid) => (
          <MachinePicker
            rows={creatable()}
            initial={currentTarget()}
            onChoose={(t) => {
              closeTabMachinePicker();
              void newTerminalTab(gid, t);
            }}
            onCancel={closeTabMachinePicker}
          />
        )}
      </Show>
      <Show when={confirmCloseTab()} keyed>
        {(c) => (
          <CloseWorkspaceCard
            kind="tab"
            name={c.name}
            onYes={() => {
              cancelCloseTab();
              void closeTermTab(c.target, c.ws, true);
            }}
            onNo={cancelCloseTab}
          />
        )}
      </Show>
    </>
  );
}
