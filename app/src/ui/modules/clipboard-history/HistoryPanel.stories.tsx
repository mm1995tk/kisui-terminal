// クリップボードの履歴の一覧（HistoryPanel.tsx）を、メインウィンドウの Dialog と同じ組み合わせ（ModalCard の中）で出す（#314）。
// 履歴を読む頼み（ListClipboardHistory。本物は Tauri の殻）だけを、決まった中身を返す偽物に差し替える。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import type { HistoryEntry } from "../../../features/clipboard/history.ts";
import { T } from "../../../i18n/index.ts";
import { ModalCard } from "../../components/Card.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { listOf, sampleHistory } from "./historyFixtures.ts";

const meta = {
  title: "modules/clipboard-history/HistoryPanel",
  component: HistoryPanel,
  args: {
    list: listOf(() => sampleHistory()),
    onPutBack: fn(async () => true),
    onClose: fn(),
  },
  // メインウィンドウの履歴の Dialog（ui/main-window/clipboard/ClipboardHistoryDialog.tsx）と同じく、真ん中のカードに入れる
  render: (args) => (
    <ModalCard label={T("history.label")} onCancel={args.onClose}>
      <HistoryPanel {...args} />
    </ModalCard>
  ),
} satisfies Meta<typeof HistoryPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 貼る欄が無いとき（Enter はクリップボードに戻す）。 */
export const Entries: Story = {};

/** 貼る欄があるとき（Enter は貼り、Shift+Enter はクリップボードに戻す）。 */
export const WithPaste: Story = {
  args: { onPaste: fn() },
};

/** 履歴がまだ無い。 */
export const Empty: Story = {
  args: { list: listOf(() => []) },
};

/** 読み込み中（殻が答えない）。 */
export const Loading: Story = {
  args: { list: () => new Promise<HistoryEntry[]>(() => {}) },
};

/** 履歴を読めなかった。 */
export const Failed: Story = {
  args: { list: () => Promise.reject(new Error("unavailable")) },
};
