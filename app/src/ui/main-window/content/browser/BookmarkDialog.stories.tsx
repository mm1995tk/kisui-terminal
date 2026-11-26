// ブックマークの一覧（BookmarkDialog.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す。
// 下の段は「選んでいるブックマーク」の行に、消す（Ctrl+D）だけ。フォルダを選んでいる間は見出しだけ（#489）。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import { BookmarkDialog } from "./BookmarkDialog.tsx";

const meta = {
  title: "main-window/content/browser/BookmarkDialog",
  component: BookmarkDialog,
  args: {
    own: [
      { url: "https://example.com/", title: "Example" },
      { url: "https://example.com/docs", title: "Docs" },
    ],
    chrome: [
      {
        kind: "folder",
        name: "Bookmarks bar",
        children: [
          {
            kind: "bookmark",
            bookmark: {
              url: "https://example.org/",
              title: "Org",
              source: "chrome",
            },
          },
        ],
      },
    ],
    failed: false,
    onOpen: fn(),
    onDelete: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof BookmarkDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 開いたところ（最初の行はブックマークなので、下の段に delete を出す）。↓ でフォルダへ移すと、見出しだけになる。 */
export const Default: Story = {};
