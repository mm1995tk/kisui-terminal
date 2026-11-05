// ターミナルのプログラムが OS のクリップボードを読もうとしたとき、許すかをユーザーに聞く窓（kitty の OSC 5522）。
// ssh 先のプログラムが手元のクリップボード（パスワードなど）を読めてしまうので、そのたびに聞く。
import { Show, type JSX } from "solid-js";

import { ModalCard } from "./connect/Card.tsx";
import { describeMimes } from "./terminal/clipboard.ts";
import { currentReadPrompt } from "./terminal/clipboardPrompt.ts";

/** 頼みが無ければ何も出さない。Esc と「許さない」は断り。 */
export function ClipboardDialog(): JSX.Element {
  return (
    <Show when={currentReadPrompt()} keyed>
      {(ask) => (
        <ModalCard
          label="クリップボードの読み取り"
          focusSelf
          onCancel={() => ask.resolve(false)}
        >
          <div class="card-body">
            <h1 class="card-title">クリップボードを読ませますか</h1>
            <p class="card-text">
              ターミナルの中のプログラムが、手元のクリップボードの中身を読もうとしています。
              ssh
              先のプログラムでも同じ頼みができます。心当たりがなければ許さないでください。
            </p>
            <p class="card-text">
              頼まれた種類：
              {describeMimes(ask.mimes)}
            </p>
          </div>
          <div class="card-actions">
            <button
              type="button"
              class="card-button"
              onClick={() => ask.resolve(false)}
            >
              許さない
            </button>
            <button
              type="button"
              class="card-button primary"
              onClick={() => ask.resolve(true)}
            >
              読ませる
            </button>
          </div>
        </ModalCard>
      )}
    </Show>
  );
}
