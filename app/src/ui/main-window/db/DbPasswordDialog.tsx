// DB のパスワードを聞く窓（#347）。kisui serve が password_required を返したときに出す。
// 打ったパスワードは、送り直す 1 回の要求に付けるだけで、窓は保存しない（features/db/controller.ts）。見た目は ssh の質問の窓と同じ。
import { T } from "../../../i18n/index.ts";
import { createSignal, type JSX } from "solid-js";

import type { DbPasswordAsk } from "../../../features/db/controller.ts";
import { Button } from "../../components/Button.tsx";
import {
  CardActions,
  CardBody,
  CardTitle,
  ModalCard,
} from "../../components/Card.tsx";
import { Field, Input } from "../../components/Field.tsx";

/** 入力欄の form。下の段の実行（form の外）が、この id で送る */
const FORM_ID = "db-password-form";

/** パスワードを聞く窓。答えは onReply に渡す（null はやめた。Esc もやめる）。 */
export function DbPasswordDialog(props: {
  ask: DbPasswordAsk;
  onReply: (password: string | null) => void;
}): JSX.Element {
  const [answer, setAnswer] = createSignal("");
  const [reveal, setReveal] = createSignal(false);
  const vars = () => ({
    connection: props.ask.connection,
    machine: props.ask.machine,
  });

  function reply(v: string | null) {
    setAnswer("");
    props.onReply(v);
  }

  return (
    <ModalCard
      label={T("db.password.label")}
      onCancel={() => reply(null)}
      header={<CardTitle>{T("db.password.label")}</CardTitle>}
      footer={
        <CardActions>
          <Button onClick={() => reply(null)}>{T("button.cancelAlt")}</Button>
          <Button type="submit" form={FORM_ID} variant="primary">
            {T("db.password.ok")}
          </Button>
        </CardActions>
      }
    >
      <form
        id={FORM_ID}
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          reply(answer());
        }}
      >
        <CardBody>
          <Field>
            <span class="card-text">
              {props.ask.reason === "missing"
                ? T("db.password.missing", vars())
                : props.ask.passwordSource === "keychain"
                  ? T("db.password.rejectedKeychain", vars())
                  : props.ask.passwordSource === "file"
                    ? T("db.password.rejectedFile", vars())
                    : T("db.password.rejected", vars())}
            </span>
            <Input
              type={reveal() ? "text" : "password"}
              value={answer()}
              autocomplete="off"
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
            {T("db.password.reveal")}
          </label>
          <p class="card-text">{T("db.password.note")}</p>
        </CardBody>
      </form>
    </ModalCard>
  );
}
