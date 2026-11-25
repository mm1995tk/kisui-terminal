// 組み合わせの例：ブラウザのタブの窓（BrowserWindow.tsx。リーダーの a。#459）を、アプリと同じ部品・CSS・字・翻訳で出す。
// タブは見本のデータ（下の page）で、操作は Actions に出るだけ（タブは変わらない）。
// 選ぶ（j k・クリック）・今できない操作の理由の表示（字を押す）・`?` は、そのまま動く。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import type { BrowserTab } from "../../../features/browser/tabs.ts";
import { KeyListDialog } from "../commands/KeyListDialog.tsx";
import { BrowserWindow } from "./BrowserWindow.tsx";

/** 戻る先のある、ふつうのページ。 */
const page: BrowserTab = {
  id: "b1",
  target: "@local",
  workspace: "w1",
  url: "https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key",
  title: "KeyboardEvent: key property - Web APIs | MDN",
  history: { back: true, forward: false },
};

const meta = {
  title: "main-window/tab-window/BrowserWindow",
  component: BrowserWindow,
  args: {
    shown: () => page,
    run: fn(),
    onClose: fn(),
  },
  // `?` の一覧は、アプリと同じく、窓の上に重ねて出す
  render: (args) => (
    <>
      <BrowserWindow {...args} />
      <KeyListDialog />
    </>
  ),
} satisfies Meta<typeof BrowserWindow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** ふつうのページ。初めは戻るを選んでいる。進む先は無く、読み込み中でもない。 */
export const Page: Story = {};

/** 読み込み中（止められる）・表示の大きさを変えた・プロキシに通している。 */
export const Loading: Story = {
  args: {
    shown: () => ({
      ...page,
      loading: { progress: 37 },
      zoom: 1.25,
      proxy: { scope: "s1", port: 18080 },
    }),
  },
};

/** シークレットのタブ。外部ブラウザでログインできない理由が出る。 */
export const Incognito: Story = {
  args: {
    shown: () => ({ ...page, incognito: true, history: undefined }),
  },
};

/** 新しいタブのページ（まだページが無い）。URL（検索窓へ）とブックマークの一覧だけが使える。 */
export const NewTab: Story = {
  args: { shown: () => ({ ...page, url: "", title: "", history: undefined }) },
};

/** 読み込めなかったページ（#432）。読み込み直すと、その URL を開き直す。 */
export const LoadFailed: Story = {
  args: {
    shown: () => ({
      ...page,
      loadError: {
        url: "https://self-signed.badssl.com/",
        reason: "cert-untrusted",
        detail: "",
      },
    }),
  },
};
