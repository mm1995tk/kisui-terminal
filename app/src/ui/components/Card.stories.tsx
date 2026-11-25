// 真ん中に出す窓の枠（Card.tsx の ModalCard）を、アプリと同じ部品・CSS・字・翻訳で出す（#315）。
// 中は窓の 3 つの段（header の見出し・中身・footer の基本操作のキー）だけ。中身のある窓の例は、
// main-window/ の窓の stories（CloseWorkspaceCard・InstallCard）。
// 使い方の決まりは docs/design/design-system.md の「窓の枠」。
import { For, type ComponentProps } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import { T } from "../../i18n/index.ts";
import {
  ModalCard,
  CardBody,
  CardTitle,
  CardText,
  CardFooter,
} from "./Card.tsx";
import { KeyHints } from "./KeyHints.tsx";

/** label と中身は翻訳の表から render の中で引くので、引数からは外す */
type Args = Omit<
  ComponentProps<typeof ModalCard>,
  "label" | "children" | "header" | "footer"
> & {
  /** 中身の段の数（多くすると、中身だけがスクロールする） */
  lines?: number;
  /** 下の段を省く */
  noFooter?: boolean;
};

const meta = {
  title: "components/ModalCard",
  args: { onCancel: fn(), lines: 1, noFooter: false },
  argTypes: {
    width: { control: { type: "number", step: 40 } },
  },
  // 字は story を出すときの言語で引く（label・中の文）
  render: (args) => (
    <ModalCard
      {...args}
      label={T("keys.label")}
      header={<CardTitle>{T("keys.label")}</CardTitle>}
      footer={
        args.noFooter ? undefined : (
          <CardFooter>
            <KeyHints items={[{ keys: ["Esc"], label: T("basic.close") }]} />
          </CardFooter>
        )
      }
    >
      <CardBody>
        <For each={Array.from({ length: args.lines ?? 1 }, (_, i) => i + 1)}>
          {(i) => (
            <CardText>
              {T("closeWorkspace.text", { name: `workspace-${i}` })}
            </CardText>
          )}
        </For>
      </CardBody>
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

/** 中身が窓の高さに収まらないとき。見出しと下の段は動かず、中身だけがスクロールする。 */
export const LongContent: Story = {
  args: { lines: 40 },
};

/** 下の段を省いた窓（閉じるのは Esc だけ）。 */
export const NoFooter: Story = {
  args: { noFooter: true },
};
