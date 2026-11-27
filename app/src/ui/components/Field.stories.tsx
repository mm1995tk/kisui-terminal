// 入力欄（Field.tsx の Field・Input）を、アプリと同じ CSS・字・翻訳で出す。
// Dialog の本文（CardBody）の中に置く決まりなので、Dialog の枠の中に並べて出す。失敗の理由は CardError（伝え方は未確定。docs/design/design-system.md）。
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";

import { T } from "../../i18n/index.ts";
import { CardBody, CardError, CardTitle, ModalCard } from "./Card.tsx";
import { Field, Input } from "./Field.tsx";

function FieldExample(props: { value: string; error?: string }) {
  return (
    <ModalCard
      label={T("addMachine.title")}
      onCancel={fn()}
      header={<CardTitle>{T("addMachine.title")}</CardTitle>}
    >
      <CardBody>
        <Field>
          {T("addMachine.name")}
          <Input
            type="text"
            value={props.value}
            placeholder={T("addMachine.namePlaceholder")}
          />
        </Field>
        {props.error && <CardError role="alert">{props.error}</CardError>}
      </CardBody>
    </ModalCard>
  );
}

const meta = {
  title: "components/Field",
  component: FieldExample,
  args: { value: "build-server" },
} satisfies Meta<typeof FieldExample>;

export default meta;
type Story = StoryObj<typeof meta>;

/** ラベルと入力欄。 */
export const Default: Story = {};

/** 空のとき（placeholder を出す）。 */
export const Empty: Story = { args: { value: "" } };

/** 断られた理由を、入力欄の下に出すとき。 */
export const WithError: Story = {
  args: { error: T("rename.err.control") },
};
