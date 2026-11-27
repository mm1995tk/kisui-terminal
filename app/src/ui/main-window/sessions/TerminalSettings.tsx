// マシンのターミナルの始め方を変える Dialog（マシンのダイアログ（リーダーの m）の t で、その上に出す。#485）。
// そのマシンの新しいターミナルが始まるフォルダとシェルを入れる。どちらも、そのマシンでのパス（~ は、そのマシンのホーム）。
// 空の欄は「書かない」で、そのマシンの設定のままになる。「保存」で呼んだ側が config.local.toml に書き、書けたら Dialog を閉じる。
// 書けなければ理由を出して、直して保存し直せるようにする。決まりは features/sessions/termDefaults.ts。
import { isComposingKey } from "../../../features/commands/ime.ts";
import { T } from "../../../i18n/index.ts";
import { createSignal, Show, type JSX } from "solid-js";

import type { TermDefaults } from "../../../features/sessions/termDefaults.ts";
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
 * ターミナルの始め方を変える Dialog。machine はマシンの名前（出すだけ）、values は今の設定（入力欄に初めに入れる）。
 * onSubmit は「保存」と Enter で呼ぶ（入れた字をそのまま渡す。確かめるのは呼んだ側）。busy の間（書いている最中）は入力と「保存」を止める。
 * error は直前に保存できなかった理由。onCancel は「キャンセル」と Esc で呼ぶ。
 */
export function TerminalSettings(props: {
  machine: string;
  values: TermDefaults;
  busy: boolean;
  error?: string;
  onSubmit: (startDir: string, shell: string) => void;
  onCancel: () => void;
}): JSX.Element {
  // Dialog は開くたびに作り直すので、初めの値は 1 回だけ読む
  const [startDir, setStartDir] = createSignal(props.values.startDir ?? "");
  const [shell, setShell] = createSignal(props.values.shell ?? "");

  function submit() {
    if (props.busy) return;
    props.onSubmit(startDir(), shell());
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
      label={T("termSettings.title")}
      onCancel={props.onCancel}
      header={<CardTitle>{T("termSettings.title")}</CardTitle>}
      status={
        <Show when={props.error}>
          {(e) => <CardError role="alert">{e()}</CardError>}
        </Show>
      }
      footer={
        <CardActions>
          <Button onClick={props.onCancel}>{T("button.cancel")}</Button>
          <Button variant="primary" busy={props.busy} onClick={submit}>
            {T("termSettings.save")}
          </Button>
        </CardActions>
      }
    >
      <CardBody>
        <CardText>
          {T("termSettings.lead", { machine: props.machine })}
        </CardText>
        <Field>
          {T("termSettings.startDir")}
          <Input
            type="text"
            placeholder={T("termSettings.startDirPlaceholder")}
            value={startDir()}
            disabled={props.busy}
            onInput={(e) => setStartDir(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            autofocus
          />
        </Field>
        <Field>
          {T("termSettings.shell")}
          <Input
            type="text"
            placeholder={T("termSettings.shellPlaceholder")}
            value={shell()}
            disabled={props.busy}
            onInput={(e) => setShell(e.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
        </Field>
      </CardBody>
    </ModalCard>
  );
}
