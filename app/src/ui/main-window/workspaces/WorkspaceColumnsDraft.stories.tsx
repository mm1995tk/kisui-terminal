// 試作：左にワークスペース・右に選んだワークスペースのタブの 2 列で、選んだ行と右の一覧を 1 枚につなげる形（WorkspaceColumnsDraft.tsx）。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import "../sidebar/sidebar.css";
import "./switcher.css";
import Switcher from "./WorkspaceSwitcher.stories.tsx";
import { WorkspaceColumnsDraft } from "./WorkspaceColumnsDraft.tsx";

const meta = {
  title: "main-window/workspaces/WorkspaceColumnsDraft",
  component: WorkspaceColumnsDraft,
  args: {
    rows: Switcher.args.rows,
    onGo: fn(),
    onTab: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof WorkspaceColumnsDraft>;

export default meta;
type Story = StoryObj<typeof meta>;

/** j / k でその列の中を、h / l で左の列（ワークスペース）と右の列（タブ）を行き来する。選んでいる行をもう 1 回押すと開く。 */
export const Default: Story = {};

const rows0 = Switcher.args.rows;
/** ワークスペースもタブも多いとき。一覧だけがスクロールし、「作る」ボタンは列の下端に残る。 */
export const Many: Story = {
  args: {
    rows: Array.from({ length: 20 }, (_, i) => {
      const r = rows0[i % rows0.length]!;
      const items = Array.from({ length: 12 }, (_, j) => {
        const t =
          r.tabs.items[j % Math.max(1, r.tabs.items.length)] ??
          rows0[0]!.tabs.items[0]!;
        return { ...t, key: `${t.key}-${i}-${j}` };
      });
      return {
        ...r,
        gws: `${r.gws}-${i}`,
        band: {
          ...r.band,
          id: `${r.gws}-${i}`,
          title: `${r.band.title} ${i + 1}`,
          focused: i === 0,
        },
        tabs: { ...r.tabs, items, shown: items[0]!.key },
      };
    }),
  },
};

/** タブを作る行。名前の入力欄の右のマシンは、Tab / Shift+Tab で替わる。 */
export const NewTab: Story = { args: { startCreate: "tab" } };

/** タブを作る行で、マシンの一覧を開いたところ（マシンを押すか ↓ で開く）。 */
export const NewTabMachineList: Story = { args: { startCreate: "list" } };
