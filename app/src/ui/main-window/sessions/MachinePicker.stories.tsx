// ワークスペースを作るマシンを選ぶ窓（MachinePicker.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す。
// 下の段は、窓だけの操作が無いので、何を選ぶかの見出しだけ（#489）。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import type { MachineRow } from "../../../features/sessions/machineList.ts";
import { MachinePicker } from "./MachinePicker.tsx";

const row = (target: string, label: string): MachineRow => ({
  target,
  label,
  health: "up",
  status: "",
  title: "",
  terminalTabs: 0,
  removable: true,
  fixed: false,
  hasSession: true,
});

const meta = {
  title: "main-window/sessions/MachinePicker",
  component: MachinePicker,
  args: {
    rows: [row("local", "local"), row("dev@build.example.com", "build-server")],
    initial: "local",
    onChoose: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof MachinePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 開いたところ。下の段は「Machine for the workspace」の見出しだけ。 */
export const Default: Story = {};
