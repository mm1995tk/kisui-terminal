// 組み合わせの例：確かめる窓（CloseWorkspaceCard.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す（#315）。
// 窓の枠（ModalCard、focusSelf）・見出しと本文（.card-body）・やめるボタンと主ボタン（Button）の組み合わせ。
// 確かめる手順そのもの（いつ出すか、何回聞くか）は変えていない（docs/design/design-system.md の「#306 との対応」）。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import { CloseWorkspaceCard } from "./CloseWorkspaceCard.tsx";

const meta = {
  title: "main-window/workspaces/CloseWorkspaceCard",
  component: CloseWorkspaceCard,
  args: { name: "kisui-terminal", onYes: fn(), onNo: fn() },
} satisfies Meta<typeof CloseWorkspaceCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** ワークスペースを閉じるとき。フォーカスは窓そのもの（Tab でボタンへ移る）。Esc は「やめる」。 */
export const Workspace: Story = {};

/** ターミナルのタブ 1 つを閉じるとき（文だけが変わる）。 */
export const Tab: Story = {
  args: { kind: "tab", name: "zsh" },
};
