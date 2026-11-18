// 名前を変える窓。機能の知識は持たず、今の名前・空にしたときの名前・断られた理由を受け取るだけ。
// 使う所：マシンの名前（ui/main-window/sessions/SessionDialogs.tsx）と、タブの名前（ui/main-window/workspaces/WorkspaceDialogs.tsx）。
// ワークスペースの名前は、帯や切り替えの窓の行の中でその場で変える（この窓は使わない）。
// 空にして決めると、名前を外して fallback に戻す。決められなかった理由（同じ名前、長すぎる名前など）は error に出す。
import { isComposingKey } from "../../../features/commands/ime.ts";
import { T } from "../../../i18n/index.ts";
import { createSignal, Show, type JSX } from "solid-js";

import { Button } from "../Button.tsx";
import {
  ModalCard,
  CardBody,
  CardTitle,
  CardError,
  CardActions,
} from "../Card.tsx";
import { Field, Input } from "../Field.tsx";

export function RenameDialog(props: {
  /** 入力欄に最初に入れる、今の名前 */
  current: string;
  /** 名前が空のときに戻る先（マシンなら ssh の行き先、タブなら番号の名前） */
  fallback: string;
  error?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [name, setName] = createSignal(props.current);
  return (
    <ModalCard
      label={T("rename.label")}
      onCancel={props.onCancel}
      header={<CardTitle>{T("rename.label")}</CardTitle>}
      footer={
        <CardActions>
          <Button onClick={props.onCancel}>{T("button.cancel")}</Button>
          <Button variant="primary" onClick={() => props.onSubmit(name())}>
            {T("rename.submit")}
          </Button>
        </CardActions>
      }
    >
      <CardBody>
        <Field>
          {T("rename.name")}
          <Input
            type="text"
            placeholder={T("rename.placeholder", { fallback: props.fallback })}
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (isComposingKey(e)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                props.onSubmit(name());
              }
            }}
            ref={(el) => queueMicrotask(() => el.select())}
            autofocus
          />
        </Field>
        <Show when={props.error}>
          {(e) => <CardError role="alert">{e()}</CardError>}
        </Show>
      </CardBody>
    </ModalCard>
  );
}
