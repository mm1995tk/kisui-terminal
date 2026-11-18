// ターミナルのプログラムが手元のファイルを書く・読もうとしたとき、許すかをユーザーに聞く窓（kitty の OSC 5113）。
// ssh 先のプログラムでも同じ頼みができるので、そのたびに聞く。
import { For, Show, type JSX } from "solid-js";

import { T } from "../../../i18n/index.ts";
import { Button } from "../../components/Button.tsx";
import { ModalCard } from "../../components/Card.tsx";
import { formatBytes } from "../../../features/file-transfer/transfer.ts";
import { currentTransferPrompt } from "../../../features/file-transfer/transferPrompt.ts";

const kindLabel = (k: "regular" | "directory" | "symlink"): string =>
  T(`transfer.kind.${k}`);

/** 頼みが無ければ何も出さない。Esc と「許さない」は断り。 */
export function TransferDialog(): JSX.Element {
  return (
    <Show when={currentTransferPrompt()} keyed>
      {(ask) => (
        <ModalCard
          label={T("transfer.label")}
          focusSelf
          onCancel={() => ask.resolve(false)}
        >
          <div class="card-body">
            <Show
              when={ask.info.direction === "read" ? ask.info : undefined}
              keyed
              fallback={
                <>
                  <h1 class="card-title">{T("transfer.write.title")}</h1>
                  <p class="card-text">{T("transfer.write.direction")}</p>
                  <p class="card-text">{T("transfer.write.ask")}</p>
                  <p class="card-text">
                    {T("transfer.write.destination", {
                      path:
                        ask.info.direction === "write"
                          ? ask.info.destination
                          : "",
                    })}
                  </p>
                  <p class="card-text">{T("transfer.write.note")}</p>
                </>
              }
            >
              {(read) => (
                <>
                  <h1 class="card-title">{T("transfer.read.title")}</h1>
                  <p class="card-text">{T("transfer.read.direction")}</p>
                  <p class="card-text">{T("transfer.read.ask")}</p>
                  <ul class="card-text">
                    <For each={read.items}>
                      {(item) => (
                        <li>
                          {item.size !== undefined
                            ? T("transfer.read.itemSize", {
                                path: item.path,
                                kind: kindLabel(item.kind),
                                size: formatBytes(item.size),
                              })
                            : T("transfer.read.item", {
                                path: item.path,
                                kind: kindLabel(item.kind),
                              })}
                        </li>
                      )}
                    </For>
                    <Show when={read.more > 0}>
                      <li>{T("transfer.read.more", { n: read.more })}</li>
                    </Show>
                  </ul>
                  <p class="card-text">
                    {T("transfer.read.total", {
                      files: read.files,
                      size: formatBytes(read.totalSize),
                    })}
                  </p>
                </>
              )}
            </Show>
          </div>
          <div class="card-actions">
            <Button onClick={() => ask.resolve(false)}>
              {T("transfer.deny")}
            </Button>
            <Button variant="primary" onClick={() => ask.resolve(true)}>
              {T("transfer.allow")}
            </Button>
          </div>
        </ModalCard>
      )}
    </Show>
  );
}
