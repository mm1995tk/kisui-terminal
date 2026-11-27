// kisui が無いマシンに入れてよいかを聞く Dialog（C6）。何を・どこから・どこへ入れるかを見せ、
// 「入れる」と押されるまで何もしない。Esc は「入れない」。
import { T } from "../../../i18n/index.ts";
import { Show, type JSX } from "solid-js";

import type { SessionState } from "../../../features/sessions/session.ts";
import { Button } from "../../components/Button.tsx";
import {
  ModalCard,
  CardBody,
  CardTitle,
  CardText,
  CardError,
  CardActions,
} from "../../components/Card.tsx";

/**
 * kisui が無いマシン（target）に、GUI と同じ版の kisui を入れてよいかを聞く Dialog。
 * 入れる版・取ってくる所・入れる先（state.plan）と、前に失敗した理由（state.error）を見せる。
 * 「入れる」で onYes、「入れない」と Esc で onNo を呼ぶ。起動時の自動接続でも開くので、
 * フォーカスはボタンではなく Dialog そのものに置く（打っていた Enter で入れ始めないように）。
 */
export function InstallCard(props: {
  /** マシンの表示名 */
  target: string;
  state: Extract<SessionState, { kind: "needs-install" }>;
  onYes: () => void;
  onNo: () => void;
}): JSX.Element {
  return (
    <ModalCard
      label={T("installCard.label")}
      onCancel={props.onNo}
      focusSelf
      header={
        <CardTitle>
          {T("installCard.title", { target: props.target })}
        </CardTitle>
      }
      footer={
        <CardActions>
          <Button onClick={props.onNo}>{T("installCard.no")}</Button>
          <Button variant="primary" onClick={props.onYes}>
            {T("installCard.yes")}
          </Button>
        </CardActions>
      }
    >
      <CardBody>
        <CardText>
          {T("installCard.text", {
            target: props.target,
            version: props.state.plan.version,
            url: props.state.plan.release_url,
            path: props.state.plan.path,
          })}
        </CardText>
        <CardText>{T("installCard.verify")}</CardText>
        <Show when={props.state.error}>
          <CardError role="alert">{props.state.error}</CardError>
        </Show>
      </CardBody>
    </ModalCard>
  );
}
