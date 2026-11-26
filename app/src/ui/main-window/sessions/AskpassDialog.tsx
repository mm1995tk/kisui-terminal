// ssh の質問（パスワード・認証コード・ホスト鍵の確認）を出す窓。見た目は窓のカード（ui/components/Card.tsx）。
// 質問の文は、つなぎ先のサーバーが決められる。別のマシンの質問と取り違えないよう、どのマシンへの接続の質問かを
// 見出しの段に出し（窓が知っている名前と色。サーバーは変えられない）、質問の文は中身の段の枠の中に等幅で出す。
import { T } from "../../../i18n/index.ts";
import { createSignal, Show, type JSX } from "solid-js";

import { Button } from "../../components/Button.tsx";
import {
  ModalCard,
  CardBody,
  CardTitle,
  CardActions,
} from "../../components/Card.tsx";
import type { AskpassMachine } from "../../../features/sessions/askpass.ts";
import type { AskpassRequest } from "../../../features/sessions/shell.ts";
import { Field, Input } from "../../components/Field.tsx";
import styles from "./AskpassDialog.module.css";

/** 入力欄の form。下の段の OK（form の外）が、この id で送る */
const FORM_ID = "askpass-form";

/**
 * 質問が無ければ何も出さない。答えは onReply に渡す（null は取り消し。Esc も取り消し）。
 * machineOf は、質問を出した接続の行き先（ask.target）のマシン（features/sessions/askpass.ts）。
 * 見出しの段に、マシンの色の丸・サイドバーに出る名前・（名前を付けていれば）ssh の行き先を出す。
 * prompt は接続先のサーバーが決められる文字列なので、「ssh が出した文」と断った枠の中にだけ出し、
 * 伏せ字にするかも prompt で決めない（既定は常に伏せ、「表示する」でユーザーが外す）。
 */
export function AskpassDialog(props: {
  ask: AskpassRequest | undefined;
  machineOf: (target: string) => AskpassMachine;
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
      {(ask) => {
        const machine = () => props.machineOf(ask.target);
        return (
          <ModalCard
            label={T("askpass.label")}
            onCancel={() => reply(ask, null)}
            header={
              <div class={styles.header}>
                <CardTitle>{T("askpass.label")}</CardTitle>
                <div
                  class={styles.machine}
                  // 色の無いマシン（足すためにつないでいる最中）は、後ろの画面のマシンの色を継がせない
                  style={{ "--machine-color": machine().color ?? "initial" }}
                >
                  <span class={styles.caption}>{T("askpass.machine")}</span>
                  <span class={styles.dot} aria-hidden="true" />
                  <span class={styles.name}>{machine().label}</span>
                  <Show when={machine().target}>
                    {(target) => <span class={styles.target}>{target()}</span>}
                  </Show>
                </div>
              </div>
            }
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
                  {T("askpass.prompt")}
                  <span class={styles.prompt}>{ask.prompt}</span>
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
        );
      }}
    </Show>
  );
}
