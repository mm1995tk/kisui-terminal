// DB の接続を選ぶ窓（DbConnectionPicker.tsx。リーダーの n → d）を、アプリと同じ部品・CSS・字・翻訳で出す。
// 行は見本のデータ（アプリでは features/db/controller.ts の openPicker が、つないでいるマシンの kisui serve から集める）。
// 操作は Storybook の Actions に出る。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import {
  emptyFields,
  type LocalDbConnections,
} from "../../../features/db/connectionForm.ts";
import type { DbPicker } from "../../../features/db/controller.ts";
import type { DbChoice } from "../../../features/db/model.ts";
import { LOCAL } from "../../../features/sessions/shell.ts";
import { T } from "../../../i18n/index.ts";
import { DbConnectionPicker } from "./DbConnectionPicker.tsx";

const choice = (
  name: string,
  target: string,
  machine: string,
  over: Partial<DbChoice["connection"]> = {},
): DbChoice => ({
  target,
  machine,
  color: target === LOCAL ? "#7aa2f7" : "#9ece6a",
  connection: {
    name,
    variant: "",
    kind: "postgres",
    host: "localhost",
    port: 5432,
    user: "app",
    database: name,
    readOnly: false,
    ...over,
  },
});

/** 見本の行：この PC の config.local.toml の接続・config.toml の接続の上書き・config.toml の接続・リモートのマシンの接続。 */
function picker(): DbPicker {
  return {
    gws: "g1",
    loading: false,
    choices: [
      choice("shop-dev", LOCAL, T("machine.local")),
      choice("shop", LOCAL, T("machine.local"), { readOnly: true }),
      choice("analytics", LOCAL, T("machine.local"), {
        kind: "mysql",
        port: 3306,
      }),
      choice("warehouse", "dev@build.example.com", "build-server", {
        host: "db.internal",
      }),
    ],
    notes: [],
  };
}

const local: LocalDbConnections = {
  local: [
    {
      ...emptyFields(),
      name: "shop-dev",
      user: "app",
      editable: true,
      overrides: false,
    },
    {
      ...emptyFields(),
      name: "shop",
      user: "app",
      readOnly: true,
      editable: true,
      overrides: true,
    },
  ],
  fixed: ["analytics"],
};

type Args = {
  /** この PC の設定を読めなかった */
  unreadable?: boolean;
  onChoose: () => void;
  onAdd: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onCancel: () => void;
};

const meta = {
  title: "main-window/db/DbConnectionPicker",
  args: {
    onChoose: fn(),
    onAdd: fn(),
    onEdit: fn(),
    onRemove: fn(),
    onCancel: fn(),
  },
  render: (args) => (
    <DbConnectionPicker
      picker={picker()}
      local={args.unreadable ? undefined : local}
      localError={
        args.unreadable
          ? T("dbConn.note.listFailed", {
              error: "config.local.toml:3: TOML として読めません",
            })
          : undefined
      }
      editing={false}
      onChoose={args.onChoose}
      onAdd={args.onAdd}
      onEdit={args.onEdit}
      onRemove={args.onRemove}
      onCancel={args.onCancel}
    />
  ),
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * すべてのマシンの接続。この PC の config.local.toml で登録している行（shop-dev と、config.toml の接続の上書きの shop）に印が付く。
 * j で config.toml の接続（analytics）・リモートの接続（warehouse）に移ると、下の段に直せない理由が出て、edit・remove が消える。
 */
export const Default: Story = {};

/** この PC の設定を読めなかった（印は付かず、理由を一覧の下に出す）。 */
export const LocalUnreadable: Story = { args: { unreadable: true } };
