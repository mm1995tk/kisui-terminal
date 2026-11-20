// ワークスペースを閉じるとき、プログラムが動いているターミナルがあれば出す確認の窓（Card.tsx の ModalCard）。
// 「終わらせて閉じる」と押されるまで何もしない。Esc は「やめる」。
import { T } from "../../../i18n/index.ts";
import type { JSX } from "solid-js";

import { Button } from "../../components/Button.tsx";
import {
  ModalCard,
  CardBody,
  CardTitle,
  CardText,
  CardActions,
} from "../../components/Card.tsx";

/**
 * 動いているプログラムを終わらせて、ワークスペースを閉じてよいかを聞く窓。
 * 「終わらせて閉じる」で onYes、「やめる」と Esc で onNo を呼ぶ。ユーザーの操作で開くが、誤って
 * 打っていた Enter が押さないよう、フォーカスはボタンではなく窓そのものに置く。
 */
export function CloseWorkspaceCard(props: {
  /** ワークスペース（tab なら、ターミナルのタブ）の表示名 */
  name: string;
  /** 閉じるのがターミナルのタブ 1 つのとき "tab"（文が変わる）。省くとワークスペース */
  kind?: "workspace" | "tab";
  onYes: () => void;
  onNo: () => void;
}): JSX.Element {
  return (
    <ModalCard
      label={T(
        props.kind === "tab" ? "closeTab.label" : "closeWorkspace.label",
      )}
      onCancel={props.onNo}
      focusSelf
      header={
        <CardTitle>
          {T(props.kind === "tab" ? "closeTab.title" : "closeWorkspace.title")}
        </CardTitle>
      }
      footer={
        <CardActions>
          <Button onClick={props.onNo}>{T("button.cancelAlt")}</Button>
          <Button variant="primary" onClick={props.onYes}>
            {T("closeWorkspace.yes")}
          </Button>
        </CardActions>
      }
    >
      <CardBody>
        <CardText>
          {T(props.kind === "tab" ? "closeTab.text" : "closeWorkspace.text", {
            name: props.name,
          })}
        </CardText>
      </CardBody>
    </ModalCard>
  );
}
