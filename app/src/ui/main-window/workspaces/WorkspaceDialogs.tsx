// ワークスペースとタブにかかわる Dialog。閉じる前の確認・Workspace switcher（リーダーの w）・種類を選ぶ Dialog・マシンを選ぶ Dialog・タブを移す先を選ぶ Dialog。
// タブの名前は、サイドバーのタブの行か、Workspace switcher の右の列の行の中で変える（sidebar/workspaces/TabRow.tsx）。
// 何を出すかは features/workspaces/controller.ts と features/workspaces/tabs/controller.ts の状態で決まる。
import { Show, type JSX } from "solid-js";

import { T } from "../../../i18n/index.ts";
import type { SwitcherStart } from "../../../features/commands/run.ts";
import type { Workspaces } from "../../../features/workspaces/controller.ts";
import type { Tabs } from "../../../features/workspaces/tabs/controller.ts";
import { MachinePicker } from "../sessions/MachinePicker.tsx";
import { CloseWorkspaceCard } from "./CloseWorkspaceCard.tsx";
import { WorkspaceKindPicker } from "./WorkspaceKindPicker.tsx";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.tsx";
import { TabMovePicker } from "./TabMovePicker.tsx";

/**
 * Workspace switcher を開いたときの初めの状態。リーダーの w・t・n（SwitcherStart）と、
 * マシンのダイアログの Enter（terminalOn。今のワークスペースで、そのマシンを設定したターミナルのタブを作る行を出しておく。#461）。
 */
export type SwitcherOpen = SwitcherStart | { terminalOn: string };

const terminalOn = (o: SwitcherOpen | undefined): string | undefined =>
  typeof o === "object" ? o.terminalOn : undefined;

/** ワークスペースとタブにかかわる Dialog をまとめて出す。出していない Dialog は何も描かない。 */
export function WorkspaceDialogs(props: {
  workspaces: Workspaces;
  tabs: Tabs;
  /** Workspace switcher を出しているか（出していれば、開いたときの初めの状態。リーダーの w は ws、t は tab、n は newTab。マシンのダイアログの Enter は terminalOn） */
  switcherOpen: SwitcherOpen | undefined;
  onCloseSwitcher: () => void;
  /** マシンの色（マシンの名前 → 色。タブを作る行のマシンに付ける） */
  colors: Record<string, string>;
  /** 内蔵ブラウザが有効か（無効なら、Workspace switcher の、作るタブの種類に、ブラウザとシークレットが無い） */
  browser: boolean;
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
    createEmptyWorkspace,
    newWorkspaceAuto,
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
    cannot,
  } = props.workspaces;
  const {
    selectTab,
    pickingFor,
    closeTabMachinePicker,
    newTerminalTab,
    createNamedTerminalTab,
    openNewBrowserTabIn,
    openDbPickerIn,
    confirmCloseTab,
    cancelCloseTab,
    closeTermTab,
    moveTabBefore,
    tabRenameInit,
    renameTab,
    closeTabRow,
    moveTabByStep,
    movingTab,
    cancelTabMove,
    submitTabMove,
  } = props.tabs;
  const closeSwitcher = () => props.onCloseSwitcher();
  return (
    <>
      <Show when={confirmClose()} keyed>
        {(c) => (
          <CloseWorkspaceCard
            name={c.name}
            onYes={() => {
              // <Show keyed> の c は値そのものなので、Dialog を閉じたあとに読んでよい（#162・#272）
              cancelClose();
              void closeWorkspace(c.gws, true);
            }}
            onNo={cancelClose}
          />
        )}
      </Show>
      <Show when={props.switcherOpen}>
        <WorkspaceSwitcher
          initialCol={props.switcherOpen === "ws" ? "ws" : "tab"}
          initialNewTab={props.switcherOpen === "newTab"}
          initialTerminal={terminalOn(props.switcherOpen)}
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
          onTabMove={(key, gid, before) => moveTabBefore(gid, key, before)}
          onCreate={createEmptyWorkspace}
          createInit={newWorkspaceAuto}
          renameInit={renameInit}
          onRename={renameWorkspace}
          onClose={(gid) => void closeWorkspace(gid)}
          tabRenameInit={tabRenameInit}
          onTabRename={renameTab}
          onTabClose={closeTabRow}
          onTabReorder={moveTabByStep}
          machines={creatable().map((m) => ({
            target: m.target,
            label: m.label,
            color: props.colors[m.target] ?? "",
          }))}
          onCreateTab={createNamedTerminalTab}
          onNewBrowserTab={openNewBrowserTabIn}
          onNewDbTab={(gid) => {
            // 接続を選ぶ Dialog は別の Dialog なので、Workspace switcher は閉じる（選んだ接続のタブは、選んでいたワークスペースに入る）
            closeSwitcher();
            openDbPickerIn(gid);
          }}
          browser={props.browser}
          onNoMachine={() =>
            cannot(T("cannot.workspace.title"), T("cannot.workspace.text"))
          }
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
      <Show when={movingTab()} keyed>
        {(m) => (
          <TabMovePicker
            title={
              rows()
                .flatMap((r) => r.tabs.items)
                .find((t) => t.key === m.key)?.title ?? ""
            }
            rows={rows().filter((r) => r.gws !== m.from)}
            onChoose={(gid) => submitTabMove(m.key, gid)}
            onCancel={cancelTabMove}
          />
        )}
      </Show>
    </>
  );
}
