// この PC の DB の接続を足す・直す・消す Dialog（DbConnectionEditor.tsx。接続を選ぶ Dialog の a・e・d）を、アプリと同じ部品・CSS・字・翻訳で出す。
// 操作は Storybook の Actions に出る。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import type { DbConnForm } from "../../../features/db/connectionController.ts";
import {
  editErrorLines,
  emptyFields,
} from "../../../features/db/connectionForm.ts";
import { DbConnectionEditor } from "./DbConnectionEditor.tsx";

type Args = {
  mode: DbConnForm["mode"];
  /** 直す・消す接続が、config.toml の接続の上書き */
  overrides?: boolean;
  /** 書けなかった理由を出す */
  rejected?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
};

const filled = {
  ...emptyFields(),
  name: "shop",
  host: "db.example.com",
  user: "app",
  database: "shop",
  tls: "verify",
  tlsCa: "~/certs/ca.pem",
  readOnly: true,
};

const meta = {
  title: "main-window/db/DbConnectionEditor",
  args: { mode: "add", onSubmit: fn(), onCancel: fn() },
  render: (args) => (
    <DbConnectionEditor
      form={{
        mode: args.mode,
        name: args.mode === "add" ? undefined : "shop",
        overrides: args.overrides ?? false,
        fields: args.mode === "add" ? emptyFields() : filled,
        busy: false,
        errors: args.rejected
          ? editErrorLines({
              kind: "invalid",
              detail: [
                { key: "port", code: "config.err.port", args: [] },
                { key: "host", code: "gui.db.hosturl", args: [] },
              ],
            })
          : [],
      }}
      onSubmit={args.onSubmit}
      onCancel={args.onCancel}
    />
  ),
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<typeof meta>;

/** a：足す（空の入力欄）。 */
export const Add: Story = {};

/** e：直す（今の値が入る。TLS が verify なので認証局の欄も出る）。 */
export const Edit: Story = { args: { mode: "edit" } };

/** 書けなかった理由を、kisui と同じキーと理由で出している。 */
export const Rejected: Story = { args: { mode: "edit", rejected: true } };

/** d：消す確かめ。 */
export const Remove: Story = { args: { mode: "remove" } };

/** d：config.toml の接続の上書きを消す確かめ（config.toml の接続に戻ると言う）。 */
export const RemoveOverride: Story = {
  args: { mode: "remove", overrides: true },
};
