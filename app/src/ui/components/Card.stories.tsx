// 真ん中に出す窓の枠（Card.tsx の ModalCard）を、アプリと同じ部品・CSS・字・翻訳で出す（#315）。
// 中は窓の決まりの並び（.card-body の見出しと、.card-actions のボタン）だけ。中身のある窓の例は、
// main-window/ の窓の stories（CloseWorkspaceCard・InstallCard）と components/RenameDialog。
// 使い方の決まりは docs/design/design-system.md の「窓の枠」。
import type { ComponentProps } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import { T } from "../../i18n/index.ts";
import { Button } from "./Button.tsx";
import { ModalCard } from "./Card.tsx";

/** label と中身は翻訳の表から render の中で引くので、引数からは外す */
type Args = Omit<ComponentProps<typeof ModalCard>, "label" | "children">;

const meta = {
  title: "components/ModalCard",
  args: { onCancel: fn() },
  argTypes: {
    width: { control: { type: "number", step: 40 } },
  },
  // 字は story を出すときの言語で引く（label・中の文）
  render: (args) => (
    <ModalCard {...args} label={T("keys.label")}>
      <div class="card-body">
        <h1 class="card-title">{T("keys.label")}</h1>
      </div>
      <div class="card-actions">
        <Button variant="primary" onClick={args.onCancel}>
          {T("button.close")}
        </Button>
      </div>
    </ModalCard>
  ),
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 既定（幅 560px）。開いたら中の最初のボタンにフォーカスが移り、Esc で onCancel。外を押しても閉じない。 */
export const Default: Story = {};

/** ユーザーの操作と関係なく開く窓（確認・知らせ）。フォーカスを窓そのものに置き、打っていた Enter がボタンを押さない。 */
export const FocusSelf: Story = {
  args: { focusSelf: true },
};

/** 打ちかけの入力が無い窓（ワークスペースを切り替える窓）。幅を広げ、外を押しても閉じる。 */
export const WideCloseOnOutside: Story = {
  args: { width: 880, closeOnOutside: true },
};
