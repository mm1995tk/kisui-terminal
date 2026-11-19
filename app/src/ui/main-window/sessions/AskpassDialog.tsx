// ssh の質問（パスワード・認証コード・ホスト鍵の確認）を出す窓。見た目は窓のカード（ui/components/Card.tsx）。
import { T } from "../../../i18n/index.ts";
import { createSignal, Show, type JSX } from "solid-js";

import { Button } from "../../components/Button.tsx";
import {
  ModalCard,
  CardBody,
  CardTitle,
  CardActions,
} from "../../components/Card.tsx";
import type { AskpassRequest } from "../../../features/sessions/shell.ts";
import { Field, Input } from "../../components/Field.tsx";

/**
 * 質問が無ければ何も出さない。答えは onReply に渡す（null は取り消し。Esc も取り消し）。
 * prompt は接続先のサーバーが決められる文字列なので、伏せ字にするかは prompt で決めない
 * （既定は常に伏せ、「表示する」でユーザーが外す）。
 */
/** 入力欄の form。下の段の OK（form の外）が、この id で送る */
const FORM_ID = "askpass-form";

export function AskpassDialog(props: {
  ask: AskpassRequest | undefined;
  onReply: (requestId: number, value: string | null) => void;
}): JSX.Element {
  const [answer, setAnswer] = createSignal("");
  const [reveal, setReveal] = createSignal(false);

  function reply(ask: AskpassRequest, value: string | null) {
    setAnswer("");
    setReveal(false);
    props.onReply(ask.requestId, value);
  }

  return (
    <Show when={props.ask} keyed>
      {(ask) => (
        <ModalCard
          label={T("askpass.label")}
          onCancel={() => reply(ask, null)}
          header={<CardTitle>{T("askpass.label")}</CardTitle>}
          footer={
            <CardActions>
              <Button onClick={() => reply(ask, null)}>
                {T("askpass.cancel")}
              </Button>
              <Button type="submit" form={FORM_ID} variant="primary">
                OK
              </Button>
            </CardActions>
          }
        >
          <form
            id={FORM_ID}
            method="dialog"
            onSubmit={(e) => {
              e.preventDefault();
              reply(ask, answer());
            }}
          >
            <CardBody>
              <Field>
                <span class="card-text">{ask.prompt}</span>
                <Input
                  type={reveal() ? "text" : "password"}
                  value={answer()}
                  onInput={(e) => setAnswer(e.currentTarget.value)}
                  autofocus
                />
              </Field>
              <label class="card-check">
                <input
                  type="checkbox"
                  checked={reveal()}
                  onChange={(e) => setReveal(e.currentTarget.checked)}
                />
                {T("askpass.reveal")}
              </label>
            </CardBody>
          </form>
        </ModalCard>
      )}
    </Show>
  );
}
