// kisui-terminal の外から開くクリップボードの履歴の Dialog（page.tsx）を出す（#314）。
// Dialog の出し入れとクリップボードへの書き込み（ClipboardPopupOs。本物は Tauri の殻）と履歴を読む頼みを、偽物に差し替える。
// 選んで戻した・Dialog を隠したは Storybook の Actions に出る。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import type { ClipboardPopupOs } from "../../../features/clipboard/history.ts";
import {
  listOf,
  sampleHistory,
} from "../../modules/clipboard-history/historyFixtures.ts";
import { ClipboardUtilityPage } from "./page.tsx";

/** 殻の偽物。Dialog は出し直されず、書き込みはいつもできる。 */
const fakeOs = (): ClipboardPopupOs => ({
  onShown: () => Promise.resolve(() => {}),
  dismiss: fn(async () => {}),
  copy: fn(async () => {}),
});

const meta = {
  title: "utilities/clipboard/ClipboardUtilityPage",
  component: ClipboardUtilityPage,
  args: {
    os: fakeOs(),
    list: listOf(() => sampleHistory()),
  },
} satisfies Meta<typeof ClipboardUtilityPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
