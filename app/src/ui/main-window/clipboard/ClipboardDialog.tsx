// ターミナルのプログラムが OS のクリップボードを読もうとしたとき、許すかをユーザーに聞く窓（kitty の OSC 5522）。
// ssh 先のプログラムが手元のクリップボード（パスワードなど）を読めてしまうので、そのたびに聞く。
import { T } from "../../../i18n/index.ts";
import { Show, type JSX } from "solid-js";

import { Button } from "../../components/Button.tsx";
import {
  ModalCard,
  CardBody,
  CardTitle,
  CardText,
  CardActions,
} from "../../components/Card.tsx";
import { describeMimes } from "../../../features/clipboard/clipboard.ts";
import { currentReadPrompt } from "../../../features/clipboard/clipboardPrompt.ts";

/** 頼みが無ければ何も出さない。Esc と「許さない」は断り。 */
export function ClipboardDialog(): JSX.Element {
  return (
    <Show when={currentReadPrompt()} keyed>
      {(ask) => (
        <ModalCard
          label={T("clipboardAsk.label")}
          focusSelf
          onCancel={() => ask.resolve(false)}
          header={<CardTitle>{T("clipboardAsk.title")}</CardTitle>}
          footer={
            <CardActions>
              <Button onClick={() => ask.resolve(false)}>
                {T("transfer.deny")}
              </Button>
              <Button variant="primary" onClick={() => ask.resolve(true)}>
                {T("clipboardAsk.allow")}
              </Button>
            </CardActions>
          }
        >
          <CardBody>
            <CardText>{T("clipboardAsk.text")}</CardText>
            <CardText>
              {T("clipboardAsk.kinds", { kinds: describeMimes(ask.mimes) })}
            </CardText>
          </CardBody>
        </ModalCard>
      )}
    </Show>
  );
}
