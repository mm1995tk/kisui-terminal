// DB の接続を選ぶ窓（DbConnectionPicker.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す。
// 下の段は、窓だけの操作が無いので、何を選ぶかの見出しだけ（#489）。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import type { DbChoice } from "../../../features/db/model.ts";

type DbConnection = DbChoice["connection"];
import { DbConnectionPicker } from "./DbConnectionPicker.tsx";

const conn = (
  name: string,
  variant: string | undefined,
  readOnly: boolean,
): DbConnection => ({
  name,
  variant,
  kind: "postgres",
  host: "db.example.com",
  port: 5432,
  user: "app",
  database: name,
  readOnly,
  human: {
    permission: "reader",
    run: "read",
    elevate: { to: "free", run: "free", maxSeconds: 1800 },
  },
  agent: { permission: "off", run: "none", propose: true, user: "app" },
});

const meta = {
  title: "main-window/db/DbConnectionPicker",
  component: DbConnectionPicker,
  args: {
    picker: {
      gws: "g1",
      loading: false,
      notes: [],
      choices: [
        {
          target: "@local",
          machine: "local",
          color: "#58a6ff",
          connection: conn("shop", "dev", false),
        },
        {
          target: "devbox",
          machine: "devbox",
          color: "#d2a8ff",
          connection: conn("shop", "prod", true),
        },
      ],
    },
    onChoose: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof DbConnectionPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 開いたところ。下の段は「Connection to open」の見出しだけ。 */
export const Default: Story = {};
