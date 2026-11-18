// ボタン（Button.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す（#315）。
// 使い方の決まり（目的・使う場面・使わない場面・状態・キー）は docs/design/design-system.md の「ボタン」。
// hover は、ポインタを乗せて見る（Storybook はポインタの状態を作れない）。
import type { ComponentProps } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import { T } from "../../i18n/index.ts";
import { Button } from "./Button.tsx";
// 並び（.card-actions）とカードの地は card.css（アプリでは Card.tsx・Notices.tsx が読む）
import "./card.css";

/** 字（children）は翻訳の表から render の中で引くので、引数からは外す */
type Args = Omit<ComponentProps<typeof Button>, "children">;

const meta = {
  title: "components/Button",
  args: { onClick: fn() },
  argTypes: {
    variant: { control: "inline-radio", options: ["secondary", "primary"] },
    type: { control: "inline-radio", options: ["button", "submit"] },
  },
  // 窓の下の並び（.card-actions）と同じ地と余白で出す
  decorators: [
    (Story) => (
      <div class="card">
        <div class="card-actions">
          <Story />
        </div>
      </div>
    ),
  ],
  // 字は story を出すときの言語で引く
  render: (args) => <Button {...args}>{T("button.cancel")}</Button>,
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 普通のボタン（やめる・閉じる・ほかの操作）。 */
export const Secondary: Story = {};

/** 主の操作。窓に 1 つ、並びの右端に置く。 */
export const Primary: Story = {
  args: { variant: "primary" },
  render: (args) => <Button {...args}>{T("rename.submit")}</Button>,
};

/** 今は押せない（押しても何も起きない）。 */
export const Disabled: Story = {
  args: { disabled: true },
};

/** 処理中。押せず、aria-busy が立つ。字を「…しています」に変えるのは呼ぶ側（新しい版の知らせの「更新しています…」）。 */
export const Busy: Story = {
  args: { variant: "primary", busy: true },
  render: (args) => <Button {...args}>{T("update.busy")}</Button>,
};

/** キーボードで移ったフォーカス（focus-visible）の枠。Tab で移ったときと同じ見た目。 */
export const Focused: Story = {
  args: { variant: "primary" },
  render: (args) => <Button {...args}>{T("rename.submit")}</Button>,
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>("button")?.focus();
  },
};

/** 組み合わせ：やめるボタンと主ボタン。主ボタンを右端に置く（窓の下の並び）。 */
export const CancelAndPrimary: Story = {
  render: (args) => (
    <>
      <Button onClick={args.onClick}>{T("button.cancel")}</Button>
      <Button variant="primary" onClick={args.onClick}>
        {T("rename.submit")}
      </Button>
    </>
  ),
};
