// ターミナルのプログラムが手元のファイルを書く・読もうとしたとき、許すかをユーザーに聞く Dialog（kitty の OSC 5113）。
// ssh 先のプログラムでも同じ頼みができるので、そのたびに聞く。
// 手元のファイルを読む頼みでは、許すと読まれるものを省かずに全部並べる（一覧の行は transferRows.ts）。
import { For, Show, type JSX } from "solid-js";

import { T } from "../../../i18n/index.ts";
import { Button } from "../../components/Button.tsx";
import {
  ModalCard,
  CardBody,
  CardTitle,
  CardText,
  CardActions,
} from "../../components/Card.tsx";
import { formatBytes } from "../../../features/file-transfer/transfer.ts";
import { currentTransferPrompt } from "../../../features/file-transfer/transferPrompt.ts";
import { readRows } from "./transferRows.ts";

/** 頼みが無ければ何も出さない。Esc と「許さない」は断り。 */
export function TransferDialog(): JSX.Element {
  return (
    <Show when={currentTransferPrompt()} keyed>
      {(ask) => (
        <ModalCard
          label={T("transfer.label")}
          focusSelf
          onCancel={() => ask.resolve(false)}
          header={
            <CardTitle>
              {T(
                ask.info.direction === "read"
                  ? "transfer.read.title"
                  : "transfer.write.title",
              )}
            </CardTitle>
          }
          footer={
            <CardActions>
              <Button onClick={() => ask.resolve(false)}>
                {T("transfer.deny")}
              </Button>
              <Button variant="primary" onClick={() => ask.resolve(true)}>
                {T("transfer.allow")}
              </Button>
            </CardActions>
          }
        >
          <CardBody>
            <Show
              when={ask.info.direction === "read" ? ask.info : undefined}
              keyed
              fallback={
                <>
                  <CardText>{T("transfer.write.direction")}</CardText>
                  <CardText>{T("transfer.write.ask")}</CardText>
                  <CardText>
                    {T("transfer.write.destination", {
                      path:
                        ask.info.direction === "write"
                          ? ask.info.destination
                          : "",
                    })}
                  </CardText>
                  <CardText>{T("transfer.write.note")}</CardText>
                </>
              }
            >
              {(read) => (
                <>
                  <CardText>{T("transfer.read.direction")}</CardText>
                  <CardText>{T("transfer.read.ask")}</CardText>
                  <CardText>
                    {T("transfer.read.total", {
                      files: read.files,
                      size: formatBytes(read.totalSize),
                    })}
                  </CardText>
                  {/* 許すと読まれるものの全部。多いときは、この一覧の中でスクロールする
                      （Tab で一覧にフォーカスを移すと、矢印・PageDown などブラウザのふつうのキーで動く） */}
                  <ul
                    class="transfer-list"
                    tabIndex={0}
                    aria-label={T("transfer.read.list")}
                  >
                    <For each={readRows(read.items)}>
                      {(row) => <li>{row}</li>}
                    </For>
                  </ul>
                </>
              )}
            </Show>
          </CardBody>
        </ModalCard>
      )}
    </Show>
  );
}
