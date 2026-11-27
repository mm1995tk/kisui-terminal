// 組み合わせの例：ターミナルのタブの Dialog（TerminalWindow.tsx。リーダーの a。#457）を、アプリと同じ部品・CSS・字・翻訳で出す。
// ペインの並びは見本のデータ（下の panes）で、分ける・入れ替える・閉じるなどの操作は Actions に出るだけ（地図は変わらない）。
// 選ぶ（h j k l・クリック）・分ける向きを待つ（s）・理由の表示（プライマリを x）・`?` は、そのまま動く。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn, userEvent, waitFor } from "storybook/test";

import { paneCells } from "../../../features/terminal/paneMap.ts";
import type { PaneSource } from "../../../features/terminal/paneMap.ts";
import { neighbor, layoutRects } from "../../../features/terminal/grid.ts";
import { KeyListDialog } from "../commands/KeyListDialog.tsx";
import { TerminalWindow } from "./TerminalWindow.tsx";

/** 左にプライマリ、右の上に名前を付けたターミナル、右の下に動画のペイン。 */
const source: PaneSource = {
  list: [
    { id: "t1", primary: true },
    { id: "t2", primary: false },
    { id: "t3", primary: false },
  ],
  extras: [
    {
      id: "x1",
      kind: "video",
      path: "/home/user/clips/demo.mp4",
      mime: "video/mp4",
      size: 1,
    },
  ],
  layout: {
    dir: "right",
    ratio: 0.55,
    a: { pane: "t1" },
    b: {
      dir: "down",
      ratio: 0.5,
      a: {
        dir: "right",
        ratio: 0.5,
        a: { pane: "t2" },
        b: { pane: "t3" },
      },
      b: { pane: "x1" },
    },
  },
  titles: { t2: "dev server" },
  activeId: "t2",
};

/** 見本のペインの並びを返す、ターミナルの持ち物の代わり。 */
const terminals = (zoomed: boolean, canZoom = true) => ({
  panes: () => paneCells(source, zoomed),
  paneNeighbor: (id: string, dir: Parameters<typeof neighbor>[2]) =>
    neighbor(layoutRects(source.layout), id, dir),
  splitPane: fn(async () => undefined),
  swapPane: fn(() => true),
  closePane: fn(() => true),
  setZoom: fn(() => true),
  canZoom: () => canZoom,
});

const meta = {
  title: "main-window/tab-window/TerminalWindow",
  component: TerminalWindow,
  args: {
    terminals: terminals(false),
    accent: "#58a6ff",
    onFocusPane: fn(),
    onResize: fn(),
    onCancel: fn(),
  },
  // `?` の一覧は、アプリと同じく、Dialog の上に重ねて出す
  render: (args) => (
    <>
      <TerminalWindow {...args} />
      <KeyListDialog />
    </>
  ),
} satisfies Meta<typeof TerminalWindow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 4 つのペイン。開いたときは、フォーカスがあるペイン（dev server）を選んでいる。 */
export const Panes: Story = {};

/** プライマリ以外を隠している間。隠れているペインも地図に出し、印を付ける。 */
export const Hidden: Story = {
  args: { terminals: terminals(true) },
};

/** プライマリで shijimi-editor が動いていない（z を押すと、隠せない理由が出る）。 */
export const CannotHide: Story = {
  args: { terminals: terminals(false, false) },
};

/** 分ける向きを待つ間（s を押したあと）。Key footer は、向きと、やめる Esc だけになる。 */
export const Splitting: Story = {
  play: async ({ canvasElement }) => {
    const map = canvasElement.querySelector<HTMLElement>("[role=listbox]");
    await waitFor(() => {
      if (!map || document.activeElement !== map)
        throw new Error("the map has no focus yet");
    });
    await userEvent.keyboard("s");
  },
};

/** Key footer の確かめ：プライマリを選んでいる間は、閉じる x を出さない（効かないので）。 */
export const PrimarySelected: Story = {
  args: {
    terminals: {
      ...terminals(false),
      panes: () => paneCells({ ...source, activeId: "t1" }, false),
    },
  },
};

/** ペインを出せない（そのタブのマシンにつながっていない）。Esc で閉じるだけ。 */
export const Empty: Story = {
  args: {
    terminals: { ...terminals(false), panes: () => [] },
  },
};
