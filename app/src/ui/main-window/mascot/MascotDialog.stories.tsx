// キャラクターを選ぶ Dialog（MascotDialog.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す。
// Key footer は、Dialog だけの操作が無いので、何を選ぶかの見出しだけ（#489）。使えないキャラクターを選んで決めたときの知らせは、Key footer の上に出る。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import { MascotDialog } from "./MascotDialog.tsx";

const meta = {
  title: "main-window/mascot/MascotDialog",
  component: MascotDialog,
  args: {
    list: async () => ({
      root: "~/.config/kisui-terminal/mascot",
      current: "tako",
      entries: [
        { name: "neko", error: null },
        { name: "tako", error: null },
        { name: "broken", error: 'mascot.toml: scene "idle" is missing' },
      ],
    }),
    onChoose: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof MascotDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 開いたところ（今のキャラクターを選んでおく）。 */
export const Default: Story = {};
