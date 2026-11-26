// ssh の質問の窓（AskpassDialog.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す。
// 見出しの段のマシン（窓が出す。色の丸・名前・ssh の行き先）と、枠の中の質問の文（ssh が出した文）の見分けを確かめる。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import type { AskpassMachine } from "../../../features/sessions/askpass.ts";
import { AskpassDialog } from "./AskpassDialog.tsx";

const ask = (prompt: string) => ({
  requestId: 1,
  conn: "c1",
  target: "dev@build.example.com",
  prompt,
});

const meta = {
  title: "main-window/sessions/AskpassDialog",
  component: AskpassDialog,
  args: {
    ask: ask("dev@build.example.com's password:"),
    machineOf: (): AskpassMachine => ({
      label: "build-server",
      target: "dev@build.example.com",
      color: "#e5b567",
    }),
    onReply: fn(),
  },
} satisfies Meta<typeof AskpassDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 名前を付けたマシン。名前の横に ssh の行き先も出す。 */
export const NamedMachine: Story = {};

/** 名前を付けていないマシン。ssh の行き先を名前として 1 回だけ出す。 */
export const UnnamedMachine: Story = {
  args: {
    machineOf: () => ({ label: "dev@build.example.com", color: "#8fb4ff" }),
  },
};

/** サイドバーにまだ無いマシン（足すためにつないでいる最中）。色が無いので、丸は枠だけ。 */
export const MachineBeingAdded: Story = {
  args: { machineOf: () => ({ label: "dev@build.example.com" }) },
};

/** 質問の文が別のマシンの名前を名乗っていても、見出しの段のマシンは変わらない。長い文は枠の中だけがスクロールする。 */
export const PromptNamesAnotherMachine: Story = {
  args: {
    ask: ask(
      "Connecting to: production\n\n(deploy@production.example.com) Password:",
    ),
  },
};
