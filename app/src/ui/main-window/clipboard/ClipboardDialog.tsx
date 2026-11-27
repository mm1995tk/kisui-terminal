// ターミナルのプログラムが OS のクリップボードを読もうとしたとき（kitty の OSC 5522）と、`kisui clipboard history` が
// クリップボードの履歴を読もうとしたとき（#517）に、許すかをユーザーに聞く Dialog。
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
import {
  currentReadPrompt,
  type ReadAsk,
} from "../../../features/clipboard/clipboardPrompt.ts";

/** 頼みの種類ごとの見出し。 */
const title = (a: ReadAsk) =>
  a.kind === "history"
    ? T("clipboardAsk.history.title")
    : T("clipboardAsk.title");

/** 頼みの種類ごとの本文。 */
function body(a: ReadAsk): JSX.Element {
  if (a.kind === "history")
    return (
      <>
        <CardText>{T("clipboardAsk.history.text", { tab: a.tab })}</CardText>
        <CardText>{T("clipboardAsk.history.range")}</CardText>
      </>
    );
  return (
    <>
      <CardText>{T("clipboardAsk.text")}</CardText>
      <CardText>
        {T("clipboardAsk.kinds", { kinds: describeMimes(a.mimes) })}
      </CardText>
    </>
  );
}

/** 頼みが無ければ何も出さない。Esc と「許さない」は断り。 */
export function ClipboardDialog(): JSX.Element {
  return (
    <Show when={currentReadPrompt()} keyed>
      {(ask) => (
        <ModalCard
          label={T("clipboardAsk.label")}
          focusSelf
          onCancel={() => ask.resolve(false)}
          header={<CardTitle>{title(ask)}</CardTitle>}
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
          <CardBody>{body(ask)}</CardBody>
        </ModalCard>
      )}
    </Show>
  );
}
