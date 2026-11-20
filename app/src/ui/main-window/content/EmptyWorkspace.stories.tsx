// 空のワークスペース（#307）を選んでいる間に、右のペインに出す画面（EmptyWorkspace.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す。
import type { Meta, StoryObj } from "storybook-solidjs-vite";

import { EmptyWorkspace } from "./EmptyWorkspace.tsx";

const meta = {
  title: "main-window/content/EmptyWorkspace",
  component: EmptyWorkspace,
  args: { leader: "Cmd+K", browser: true },
  decorators: [
    (Story) => (
      <div style={{ position: "relative", height: "420px" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EmptyWorkspace>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 内蔵ブラウザを使うとき。ブラウザのタブを足すキーも出す。 */
export const WithBrowser: Story = {};

/** 内蔵ブラウザを使わないとき（設定の [gui.browser] enabled が false）。ターミナルのタブを足すキーだけ。 */
export const WithoutBrowser: Story = { args: { browser: false } };
