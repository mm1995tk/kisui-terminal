// ターミナルのプログラムが手元のファイルを書く・読もうとしたとき、許すかをユーザーに聞く窓（kitty の OSC 5113）。
// ssh 先のプログラムでも同じ頼みができるので、そのたびに聞く。
import { For, Show, type JSX } from "solid-js";

import { ModalCard } from "./connect/Card.tsx";
import { formatBytes } from "./terminal/transfer.ts";
import { currentTransferPrompt } from "./terminal/transferPrompt.ts";

const KIND = {
  regular: "ファイル",
  directory: "ディレクトリ",
  symlink: "リンク",
} as const;

/** 頼みが無ければ何も出さない。Esc と「許さない」は断り。 */
export function TransferDialog(): JSX.Element {
  return (
    <Show when={currentTransferPrompt()} keyed>
      {(ask) => (
        <ModalCard
          label="ファイルの転送"
          focusSelf
          onCancel={() => ask.resolve(false)}
        >
          <div class="card-body">
            <Show
              when={ask.info.direction === "read" ? ask.info : undefined}
              keyed
              fallback={
                <>
                  <h1 class="card-title">ファイルを受け取りますか</h1>
                  <p class="card-text">
                    向き：ターミナルのプログラム → 手元（手元に書く）
                  </p>
                  <p class="card-text">
                    ターミナルの中のプログラムが、手元の次のディレクトリにファイルを書こうとしています。ssh
                    先のプログラムでも同じ頼みができます。心当たりがなければ許さないでください。
                  </p>
                  <p class="card-text">
                    書き込み先：
                    {ask.info.direction === "write" && ask.info.destination}
                  </p>
                  <p class="card-text">
                    どのファイルが来るかは、許したあとに分かります。ここより外には書きません。同じ名前のファイルは上書きせず、リンクも作りません。
                  </p>
                </>
              }
            >
              {(read) => (
                <>
                  <h1 class="card-title">手元のファイルを送りますか</h1>
                  <p class="card-text">
                    向き：手元 → ターミナルのプログラム（手元から読む）
                  </p>
                  <p class="card-text">
                    ターミナルの中のプログラムが、手元の次のファイルを読もうとしています。ssh
                    先のプログラムでも同じ頼みができます。心当たりがなければ許さないでください。
                  </p>
                  <ul class="card-text">
                    <For each={read.items}>
                      {(item) => (
                        <li>
                          {item.path}（{KIND[item.kind]}
                          {item.size !== undefined &&
                            `、${formatBytes(item.size)}`}
                          ）
                        </li>
                      )}
                    </For>
                    <Show when={read.more > 0}>
                      <li>ほか {read.more} 件</li>
                    </Show>
                  </ul>
                  <p class="card-text">
                    ファイル {read.files} 件、合計 {formatBytes(read.totalSize)}
                  </p>
                </>
              )}
            </Show>
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
              許す
            </button>
          </div>
        </ModalCard>
      )}
    </Show>
  );
}
