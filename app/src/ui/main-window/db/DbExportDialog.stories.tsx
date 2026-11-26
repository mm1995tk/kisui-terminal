// DB のタブの結果の書き出しの窓（DbExportDialog.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す。
// 下の段は、窓だけの操作が無いので、何を選ぶかの見出しだけ（#489）。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import { DbExportDialog } from "./DbExportDialog.tsx";

const meta = {
  title: "main-window/db/DbExportDialog",
  component: DbExportDialog,
  args: {
    ask: { tab: "d1", rows: 120, truncated: false, truncatedCells: false },
    onChoose: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof DbExportDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 開いたところ。下の段は「Format and destination」の見出しだけ。 */
export const Default: Story = {};

/** 結果が上限で切れているとき（窓の上に知らせが出る）。 */
export const Truncated: Story = {
  args: {
    ask: { tab: "d1", rows: 1000, truncated: true, truncatedCells: true },
  },
};
