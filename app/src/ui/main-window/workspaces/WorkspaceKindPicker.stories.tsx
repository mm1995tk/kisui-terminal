// ワークスペースの種類（ターミナルかブラウザか）を選ぶ Dialog（WorkspaceKindPicker.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import { WorkspaceKindPicker } from "./WorkspaceKindPicker.tsx";

const meta = {
  title: "main-window/workspaces/WorkspaceKindPicker",
  component: WorkspaceKindPicker,
  args: { onChoose: fn(), onCancel: fn() },
} satisfies Meta<typeof WorkspaceKindPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 開いたところ。j / k で選び、Enter かダブルクリックで決める。Esc かボタンでやめる。 */
export const Default: Story = {};
