// マシンのダイアログ（MachineDialog.tsx。リーダーの m）を、アプリと同じ部品・CSS・字・翻訳で出す。
// 行は見本のデータ（アプリでは features/sessions/machineList.ts が作る）。操作は Storybook の Actions に出る。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import type { MachineRow } from "../../../features/sessions/machineList.ts";
import { T } from "../../../i18n/index.ts";
import { MachineDialog } from "./MachineDialog.tsx";

/** 見本の行。状態の文は story を出すときの言語で引く */
function rows(): MachineRow[] {
  return [
    {
      target: "local",
      label: T("machine.local"),
      health: "up",
      status: T("health.up"),
      title: "",
      terminalTabs: 2,
      removable: false,
      fixed: false,
      hasSession: true,
    },
    {
      target: "dev@build.example.com",
      label: "build-server",
      health: "up",
      status: T("health.up"),
      title: "",
      terminalTabs: 1,
      removable: true,
      fixed: false,
      hasSession: true,
    },
    {
      target: "devbox",
      label: "devbox",
      health: "down",
      status: T("health.down"),
      title: "",
      terminalTabs: 0,
      removable: true,
      fixed: true,
      hasSession: false,
      retry: "now",
    },
  ];
}

type Args = {
  /** 開いたときに選んでおくマシンの ssh の行き先 */
  initial?: string;
  /** 名前を変えている行の ssh の行き先（無ければ変えていない） */
  renamingTarget?: string;
  /** 名前を断られた理由を出す */
  rejected?: boolean;
  onAdd: () => void;
  onAct: () => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onCancel: () => void;
};

const meta = {
  title: "main-window/sessions/MachineDialog",
  args: {
    onAdd: fn(),
    onAct: fn(),
    onRenameSubmit: fn(),
    onRenameCancel: fn(),
    onCancel: fn(),
  },
  render: (args) => (
    <MachineDialog
      rows={rows()}
      initial={args.initial ?? "dev@build.example.com"}
      hasWorkspace
      renaming={
        args.renamingTarget
          ? {
              target: args.renamingTarget,
              error: args.rejected
                ? T("rename.err.tooLongMax", { max: 64 })
                : undefined,
            }
          : null
      }
      onAdd={args.onAdd}
      onAct={args.onAct}
      onRenameSubmit={args.onRenameSubmit}
      onRenameCancel={args.onRenameCancel}
      onCancel={args.onCancel}
    />
  ),
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<typeof meta>;

/** すべてのマシンと、つながりの状態・ターミナルのタブの数。 */
export const Default: Story = {};

/** n で名前を変えている（選んだ行の名前が、その場の入力欄になる）。 */
export const Renaming: Story = {
  args: { renamingTarget: "dev@build.example.com" },
};

/** 名前を断られた理由を、入力欄の下に出している。 */
export const RenameRejected: Story = {
  args: { renamingTarget: "dev@build.example.com", rejected: true },
};

/** config.toml にだけあって、つながっていないマシンを選んでいる。Key footer には、今できる操作（r だけ）が出る。 */
export const FixedDisconnected: Story = {
  args: { initial: "devbox" },
};

/** 「ローカル」を選んでいる。外す・名前を変える・切るは出ない。 */
export const Local: Story = {
  args: { initial: "local" },
};
