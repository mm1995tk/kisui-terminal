// コーディングエージェントが DB のタブの入力欄に SQL を書こうとしたとき（`kisui db propose`。#382）、入力欄に SQL があれば、
// 上書きしてよいかを聞く窓。Enter と「上書きする」で上書き、Esc と「やめる」でやめる。どちらでも SQL は実行しない。
// 聞く・答えを返すのは features/db/proposeController.ts。
import { T } from "../../../i18n/index.ts";
import { onCleanup, onMount, type JSX } from "solid-js";

import { isProposeEnter } from "../../../features/db/propose.ts";
import type { DbProposeAsk } from "../../../features/db/proposeController.ts";
import { Button } from "../../components/Button.tsx";
import {
  CardActions,
  CardBody,
  CardText,
  CardTitle,
  ModalCard,
} from "../../components/Card.tsx";
import styles from "./DbProposeDialog.module.css";

/** 上書きしてよいかを聞く窓。答えは onReply に渡す（false はやめた。Esc もやめる）。 */
export function DbProposeDialog(props: {
  ask: DbProposeAsk;
  onReply: (yes: boolean) => void;
}): JSX.Element {
  let body!: HTMLDivElement;
  const opened = performance.now();
  // フォーカスは窓そのものにある（focusSelf）ので、Enter は窓（dialog）で受ける
  const onKeyDown = (e: KeyboardEvent) => {
    const onButton = e.target instanceof HTMLButtonElement;
    if (!isProposeEnter(e, performance.now() - opened, onButton)) return;
    e.preventDefault();
    props.onReply(true);
  };
  let dialog: HTMLElement | null = null;
  onMount(() => {
    dialog = body.closest("dialog");
    dialog?.addEventListener("keydown", onKeyDown);
  });
  onCleanup(() => dialog?.removeEventListener("keydown", onKeyDown));

  return (
    <ModalCard
      label={T("db.propose.label")}
      width={640}
      focusSelf
      onCancel={() => props.onReply(false)}
      header={
        <CardTitle>
          {T("db.propose.title", { connection: props.ask.connection })}
        </CardTitle>
      }
      footer={
        <CardActions>
          <Button onClick={() => props.onReply(false)}>
            {T("button.cancelAlt")}
          </Button>
          <Button variant="primary" onClick={() => props.onReply(true)}>
            {T("db.propose.yes")}
          </Button>
        </CardActions>
      }
    >
      <CardBody ref={body}>
        <CardText>
          {T("db.propose.text", {
            connection: props.ask.connection,
            machine: props.ask.machine,
          })}
        </CardText>
        <CardText>{T("db.propose.new")}</CardText>
        <pre class={styles.sql}>{props.ask.sql}</pre>
        <CardText>{T("db.propose.current")}</CardText>
        <pre class={styles.sql}>{props.ask.current}</pre>
      </CardBody>
    </ModalCard>
  );
}
