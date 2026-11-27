// その場の入力欄（InlineInput.tsx）を、アプリと同じ CSS・字・翻訳で出す。
// アプリでは一覧の行の中に置く（Workspace band・Workspace switcher の行・タブの行・マシンのダイアログの行・ファイルツリーの行）。
// ここでは行の幅（サイドバーと同じ 280px）の箱の中に出す。決めた・やめたは Storybook の Actions に出る。
import type { ComponentProps } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import { T } from "../../i18n/index.ts";
import { InlineInput } from "./InlineInput.tsx";

/** label・placeholder・error は翻訳の表から render の中で引くので、引数からは外す */
type Args = Omit<
  ComponentProps<typeof InlineInput>,
  "label" | "placeholder" | "error"
> & {
  /** 断られた理由を出す */
  rejected?: boolean;
};

const meta = {
  title: "components/InlineInput",
  args: {
    value: "build-server",
    rejected: false,
    onSubmit: fn(),
    onCancel: fn(),
  },
  render: (args) => (
    <div style={{ width: "280px", padding: "var(--space-8)" }}>
      <InlineInput
        value={args.value}
        selection={args.selection}
        onSubmit={args.onSubmit}
        onCancel={args.onCancel}
        label={T("sidebar.nameLabel")}
        placeholder={T("sidebar.namePlaceholder", { auto: "ws1" })}
        error={
          args.rejected ? T("rename.err.tooLongMax", { max: 64 }) : undefined
        }
      />
    </div>
  ),
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 名前を付けてあるとき。開くと全部を選んでおく。 */
export const Named: Story = {};

/** 名前を付けていないとき（空にして決めたときに戻る名前を、薄い字で出す）。 */
export const Empty: Story = { args: { value: "" } };

/** 断られた理由を、入力欄の下に出している（入力欄は開けたまま）。 */
export const WithError: Story = { args: { rejected: true } };
