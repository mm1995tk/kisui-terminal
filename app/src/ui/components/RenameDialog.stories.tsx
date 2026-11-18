// 名前を変える窓（RenameDialog.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す（#314）。
// 決めた・やめたは Storybook の Actions に出る（本物では、マシンの名前を変える機能が受け取る）。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import { T } from "../../i18n/index.ts";
import { RenameDialog } from "./RenameDialog.tsx";

const meta = {
  title: "components/RenameDialog",
  component: RenameDialog,
  args: {
    current: "build-server",
    fallback: "dev@build.example.com",
    onSubmit: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof RenameDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 名前を付けてあるマシン。 */
export const Named: Story = {};

/** 名前を付けていないマシン（今の名前は ssh の行き先）。 */
export const Unnamed: Story = {
  args: { current: "dev@build.example.com" },
};

/** 決められなかった理由を出している。文は story を出すときの言語で引く。 */
export const WithError: Story = {
  render: (args) => (
    <RenameDialog {...args} error={T("rename.err.tooLongMax", { max: 64 })} />
  ),
};
