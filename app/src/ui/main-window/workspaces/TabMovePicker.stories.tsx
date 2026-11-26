// タブを移す先のワークスペースを選ぶ窓（TabMovePicker.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す。
// 下の段は、窓だけの操作が無いので、何を選ぶかの見出しだけ（#489）。行（Row）は見本のデータ。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import type { Row } from "../../../features/workspaces/rows.ts";
import { TabMovePicker } from "./TabMovePicker.tsx";

function row(gws: string, title: string, tabs: number): Row {
  return {
    gws,
    target: "local",
    machine: "local",
    color: "#58a6ff",
    health: "up",
    band: {
      id: gws,
      title,
      label: "",
      autoTitle: title,
      path: false,
      unset: false,
      detail: "",
      dir: "",
      branch: "main",
      sha: "81c705b",
      note: "",
      num: "",
      root: `~/workspaces/${title}`,
      focused: false,
      showTree: false,
    },
    tabs: {
      items: Array.from({ length: tabs }, (_, i) => ({
        key: `${gws}-${i}`,
        kind: "browser" as const,
        title: `tab ${i + 1}`,
        path: "",
        git: "",
        tip: "",
        incognito: false,
        tab: `${gws}-${i}`,
        closable: true,
      })),
      shown: "",
      focused: false,
    },
  };
}

const meta = {
  title: "main-window/workspaces/TabMovePicker",
  component: TabMovePicker,
  args: {
    title: "Storybook",
    rows: [
      row("g2", "shijimi-editor", 3),
      row("g3", "api-server", 1),
      row("g4", "scratch", 0),
    ],
    onChoose: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof TabMovePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 開いたところ。移す先を j / k で選び、Enter で移す。下の段は「Workspace to move the tab to」の見出しだけ。 */
export const Default: Story = {};
