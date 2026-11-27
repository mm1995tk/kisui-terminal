// キーの一覧（KeyListDialog.tsx。リーダーの `?`）を、アプリと同じ部品・CSS・字・翻訳で出す。
// 一覧はモジュールの signal で開くので、出すときに openKeyList を呼ぶ。
import type { Meta, StoryObj } from "storybook-solidjs-vite";

import { KeyListDialog, openKeyList } from "./KeyListDialog.tsx";

const meta = {
  title: "main-window/commands/KeyListDialog",
  component: KeyListDialog,
  render: () => {
    openKeyList();
    return <KeyListDialog />;
  },
} satisfies Meta<typeof KeyListDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** リーダーの `?` で開いたところ。説明文と列の見出しは、一覧をスクロールしても同じ位置に残る（スクロールした途端に上へ跳ねない）。 */
export const Leader: Story = {};
