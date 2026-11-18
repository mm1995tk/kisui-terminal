// 組み合わせの例：kisui を入れてよいかを聞く窓（InstallCard.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す（#315）。
// 窓の枠（ModalCard、focusSelf）・本文・前に失敗した理由（.card-error）・ボタン（Button）の組み合わせ。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import { InstallCard } from "./InstallCard.tsx";

const plan = {
  version: "0.9.0",
  path: "~/.cache/kisui-terminal/0.9.0/kisui",
  release_url: "https://github.com/mm1995tk/kisui-terminal/releases/tag/v0.9.0",
};

const meta = {
  title: "main-window/sessions/InstallCard",
  component: InstallCard,
  args: {
    target: "build-server",
    state: { kind: "needs-install", plan },
    onYes: fn(),
    onNo: fn(),
  },
} satisfies Meta<typeof InstallCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 初めて聞くとき。 */
export const Ask: Story = {};

/** 前に入れようとして失敗したとき。理由は殻（ssh）が返した文のまま、等幅で出す。 */
export const AfterFailure: Story = {
  args: {
    state: {
      kind: "needs-install",
      plan,
      error:
        "scp: ~/.cache/kisui-terminal/0.9.0/kisui: No space left on device",
    },
  },
};
