// ワークスペースとタブにかかわる窓。閉じる前の確認・ワークスペースを切り替える窓（リーダーの w）・種類を選ぶ窓・マシンを選ぶ窓・タブの名前を変える窓。
// 何を出すかは features/workspaces/controller.ts と features/workspaces/tabs/controller.ts の状態で決まる。
import { Show, type JSX } from "solid-js";

import type { BrowserTabs } from "../../../features/browser/tabsStore.ts";
import type { Sessions } from "../../../features/sessions/controller.ts";
import type { Workspaces } from "../../../features/workspaces/controller.ts";
import { band } from "../../../features/workspaces/rows.ts";
import type { Tabs } from "../../../features/workspaces/tabs/controller.ts";
import { RenameDialog } from "../../components/RenameDialog.tsx";
import { MachinePicker } from "../sessions/MachinePicker.tsx";
import { CloseWorkspaceCard } from "./CloseWorkspaceCard.tsx";
import { WorkspaceKindPicker } from "./WorkspaceKindPicker.tsx";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.tsx";

export function WorkspaceDialogs(props: {
  sessions: Pick<Sessions, "workspaces">;
  workspaces: Workspaces;
  tabs: Tabs;
  browserTabs: BrowserTabs;
  /** ワークスペースを切り替える窓（リーダーの w）を出しているか */
  switcherOpen: boolean;
  onCloseSwitcher: () => void;
}): JSX.Element {
  // 部品は作り直さないので、持ち物は 1 回だけ取り出す
  const { workspaces } = props.sessions;
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
    renamingTerm,
    termRenameError,
    submitTermRename,
    cancelTermRename,
    renamingTab,
    tabRenameError,
    submitTabRename,
    cancelTabRename,
  } = props.tabs;
  const { tabs } = props.browserTabs;
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
      <Show when={renamingTerm()} keyed>
        {(r) => (
          <RenameDialog
            current={
              workspaces()[r.target]?.find((w) => w.id === r.ws)?.label ?? ""
            }
            fallback={(() => {
              const w = workspaces()[r.target]?.find((x) => x.id === r.ws);
              return w ? band({ ...w, label: "" }, false).title : "";
            })()}
            error={termRenameError()}
            onSubmit={(name) => void submitTermRename(name)}
            onCancel={cancelTermRename}
          />
        )}
      </Show>
      <Show when={renamingTab()} keyed>
        {(id) => (
          <RenameDialog
            current={
              gws()
                .list.flatMap((g) => g.tabs)
                .flatMap((r) =>
                  r.kind === "browser" && r.id === id ? [r.name ?? ""] : [],
                )[0] ?? ""
            }
            fallback={tabs().tabs.find((t) => t.id === id)?.title ?? ""}
            error={tabRenameError()}
            onSubmit={submitTabRename}
            onCancel={cancelTabRename}
          />
        )}
      </Show>
    </>
  );
}
