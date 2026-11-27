// ssh 先のマシンのペインに、手元の PC のペインの操作（kisui pane … --machine local）を、時間を決めて許す Dialog
// （マシンのダイアログ（リーダーの m）の p で、その上に出す）。決まりは features/sessions/paneGrant.ts。
// 入れるのは時間だけ（"30m"・"1h"・"1h30m"。DB の権限の引き上げと同じ書き方）。「Allow」と Enter で、呼んだ側が許して Dialog を閉じる。
// 読めない時間・長すぎる時間は、理由を出して直せるようにする。
import { isComposingKey } from "../../../features/commands/ime.ts";
import { T } from "../../../i18n/index.ts";
import { createSignal, Show, type JSX } from "solid-js";

import {
  GRANT_DEFAULT,
  parseGrantTime,
} from "../../../features/sessions/paneGrant.ts";
import { Button } from "../../components/Button.tsx";
import {
  ModalCard,
  CardBody,
  CardTitle,
  CardText,
  CardError,
  CardActions,
} from "../../components/Card.tsx";
import { Field, Input } from "../../components/Field.tsx";

/**
 * 時間を決めて許す Dialog。machine はマシンの名前（出すだけ）。onSubmit は「Allow」と Enter で、読めた時間（秒）を渡して呼ぶ。
 * onCancel は「Cancel」と Esc で呼ぶ。
 */
export function PaneGrantDialog(props: {
  machine: string;
  onSubmit: (seconds: number) => void;
  onCancel: () => void;
}): JSX.Element {
  const [time, setTime] = createSignal(GRANT_DEFAULT);
  const [error, setError] = createSignal<string | undefined>();

  function submit() {
    const r = parseGrantTime(time());
    if ("error" in r) setError(r.error);
    else props.onSubmit(r.seconds);
  }
  function onKeyDown(e: KeyboardEvent) {
    if (isComposingKey(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  }

  return (
    <ModalCard
      label={T("paneGrant.title")}
      onCancel={props.onCancel}
      header={<CardTitle>{T("paneGrant.title")}</CardTitle>}
      footer={
        <CardActions>
          <Button onClick={props.onCancel}>{T("button.cancel")}</Button>
          <Button variant="primary" onClick={submit}>
            {T("paneGrant.allow")}
          </Button>
        </CardActions>
      }
    >
      <CardBody>
        <CardText>{T("paneGrant.lead", { machine: props.machine })}</CardText>
        <Field>
          {T("paneGrant.time")}
          <Input
            type="text"
            value={time()}
            onInput={(e) => {
              setTime(e.currentTarget.value);
              setError(undefined);
            }}
            onKeyDown={onKeyDown}
            autofocus
          />
        </Field>
        <Show when={error()}>
          {(e) => <CardError role="alert">{e()}</CardError>}
        </Show>
      </CardBody>
    </ModalCard>
  );
}
