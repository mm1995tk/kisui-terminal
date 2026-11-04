// ssh の質問（パスワード・認証コード・ホスト鍵の確認）を出す窓。見た目は窓のカード（connect/Card.tsx）。
import { createSignal, Show, type JSX } from "solid-js";

import { ModalCard } from "./connect/Card.tsx";
import type { AskpassRequest } from "./ssh/api.ts";

/**
 * 質問が無ければ何も出さない。答えは onReply に渡す（null は取り消し。Esc も取り消し）。
 * prompt は接続先のサーバーが決められる文字列なので、伏せ字にするかは prompt で決めない
 * （既定は常に伏せ、「表示する」でユーザーが外す）。
 */
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
        <ModalCard label="ssh の質問" onCancel={() => reply(ask, null)}>
          <form
            method="dialog"
            onSubmit={(e) => {
              e.preventDefault();
              reply(ask, answer());
            }}
          >
            <div class="card-body">
              <h1 class="card-title">ssh の質問</h1>
              <label class="card-field">
                <span class="card-text">{ask.prompt}</span>
                <input
                  class="card-input"
                  type={reveal() ? "text" : "password"}
                  value={answer()}
                  onInput={(e) => setAnswer(e.currentTarget.value)}
                  autofocus
                />
              </label>
              <label class="card-check">
                <input
                  type="checkbox"
                  checked={reveal()}
                  onChange={(e) => setReveal(e.currentTarget.checked)}
                />
                表示する（host key の確認は yes / no と打つ）
              </label>
            </div>
            <div class="card-actions">
              <button
                type="button"
                class="card-button"
                onClick={() => reply(ask, null)}
              >
                取り消し
              </button>
              <button type="submit" class="card-button primary">
                OK
              </button>
            </div>
          </form>
        </ModalCard>
      )}
    </Show>
  );
}
