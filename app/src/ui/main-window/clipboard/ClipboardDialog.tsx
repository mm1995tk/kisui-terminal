// ターミナルのプログラムが OS のクリップボードを読もうとしたとき、許すかをユーザーに聞く窓（kitty の OSC 5522）。
// ssh 先のプログラムが手元のクリップボード（パスワードなど）を読めてしまうので、そのたびに聞く。
import { T } from "../../../i18n/index.ts";
import { Show, type JSX } from "solid-js";

import { ModalCard } from "../../components/Card.tsx";
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
        >
          <div class="card-body">
            <h1 class="card-title">{T("clipboardAsk.title")}</h1>
            <p class="card-text">{T("clipboardAsk.text")}</p>
            <p class="card-text">
              {T("clipboardAsk.kinds", { kinds: describeMimes(ask.mimes) })}
            </p>
          </div>
          <div class="card-actions">
            <button
              type="button"
              class="card-button"
              onClick={() => ask.resolve(false)}
            >
              {T("transfer.deny")}
            </button>
            <button
              type="button"
              class="card-button primary"
              onClick={() => ask.resolve(true)}
            >
              {T("clipboardAsk.allow")}
            </button>
          </div>
        </ModalCard>
      )}
    </Show>
  );
}
