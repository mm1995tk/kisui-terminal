// ssh 先のマシンのペインが、手元の PC のペインに頼んだこと（kisui pane … --machine local）を、許すかを聞く Dialog。
// 出るのは、人がそのマシンに時間を決めて許している間（マシンのダイアログの p）だけ。決まりは features/sessions/paneApproval.ts。
//
// - ペインを作る頼み：動かすコマンド・フォルダ・名前・入れるワークスペースを、省かずに全部見せる。選ぶのは
//   「Deny」「Allow, ask each time」（作ったペインへの操作も毎回聞く）「Allow, do not ask for this pane」（以後聞かない）。
// - 「毎回聞く」ペインへの操作（send・keys・read・close）：送る字・押すキーを全部見せる。選ぶのは「Deny」「Allow」。
// 「Deny」を最初のボタンにして、開いたときのフォーカスを置く（急いで Enter を押しても、何も許さない）。Esc も断り。
// どのマシンの頼みか（Dialog が知っている名前）は、そのマシンが決めた字（コマンド・名前・送る字）とは別の所に出す。
import { T } from "../../../i18n/index.ts";
import { For, Match, Show, Switch, type JSX } from "solid-js";

import {
  currentPaneApproval,
  type PaneApproval,
} from "../../../features/sessions/paneApproval.ts";
import { Button } from "../../components/Button.tsx";
import {
  ModalCard,
  CardBody,
  CardTitle,
  CardText,
  CardActions,
} from "../../components/Card.tsx";

/** 見出しと中身の 1 組（中身は、そのマシンが決めた字。等幅で、折り返して全部出す）。 */
function Item(props: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </>
  );
}

/** コマンドの語を、区切りが分かるように 1 行にする（空白や引用符を含む語は JSON の書き方で囲む）。 */
export function commandText(argv: readonly string[]): string {
  return argv
    .map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a)))
    .join(" ");
}

function OpenBody(props: {
  ask: Extract<PaneApproval, { kind: "open" }>;
}): JSX.Element {
  const a = () => props.ask;
  return (
    <dl class="approval-items">
      <Item
        label={T("paneApproval.field.command")}
        value={
          a().argv.length > 0 ? commandText(a().argv) : T("paneApproval.shell")
        }
      />
      <Item
        label={T("paneApproval.field.cwd")}
        value={a().cwd || T("paneApproval.startDir")}
      />
      <Item label={T("paneApproval.field.name")} value={a().name} />
      <Item
        label={
          a().isNew
            ? T("paneApproval.field.workspaceNew")
            : T("paneApproval.field.workspace")
        }
        value={a().workspace}
      />
    </dl>
  );
}

function OpBody(props: {
  ask: Extract<PaneApproval, { kind: "op" }>;
}): JSX.Element {
  const a = () => props.ask;
  return (
    <dl class="approval-items">
      <Switch>
        <Match when={a().cmd === "send"}>
          <Item label={T("paneApproval.op.send")} value={a().text ?? ""} />
        </Match>
        <Match when={a().cmd === "keys"}>
          <Item
            label={T("paneApproval.op.keys")}
            value={(a().keys ?? []).join(" ")}
          />
        </Match>
        <Match when={a().cmd === "read"}>
          <Item label={T("paneApproval.op.read")} value="" />
        </Match>
        <Match when={a().cmd === "close"}>
          <Item label={T("paneApproval.op.close")} value="" />
        </Match>
      </Switch>
    </dl>
  );
}

/** 頼みが無ければ何も出さない。machineOf は、頼んだマシン（ssh の行き先）の、Dialog が知っている名前。 */
export function PaneApprovalDialog(props: {
  machineOf: (target: string) => string;
}): JSX.Element {
  return (
    <Show when={currentPaneApproval()} keyed>
      {(ask) => {
        const deny = () =>
          ask.kind === "open" ? ask.resolve("deny") : ask.resolve(false);
        const machine = props.machineOf(ask.from);
        return (
          <ModalCard
            label={T("paneApproval.label")}
            onCancel={deny}
            header={
              <CardTitle>
                {ask.kind === "open"
                  ? T("paneApproval.title.open")
                  : T("paneApproval.title.op")}
              </CardTitle>
            }
            footer={
              <CardActions>
                {/* 最初のボタン（開いたときにフォーカスが来る）は「Deny」 */}
                <Button onClick={deny}>{T("paneApproval.deny")}</Button>
                <Show
                  when={ask.kind === "open" ? ask : undefined}
                  fallback={
                    <Button
                      onClick={() => ask.kind === "op" && ask.resolve(true)}
                    >
                      {T("paneApproval.allow")}
                    </Button>
                  }
                >
                  {(open) => (
                    <For
                      each={
                        [
                          ["allow-ask", "paneApproval.allowAsk"],
                          ["allow", "paneApproval.allowQuiet"],
                        ] as const
                      }
                    >
                      {([d, label]) => (
                        <Button onClick={() => open().resolve(d)}>
                          {T(label)}
                        </Button>
                      )}
                    </For>
                  )}
                </Show>
              </CardActions>
            }
          >
            <CardBody>
              <CardText>
                {ask.kind === "open"
                  ? T("paneApproval.lead.open", { machine })
                  : T("paneApproval.lead.op", { machine, pane: ask.pane })}
              </CardText>
              {ask.kind === "open" ? (
                <OpenBody ask={ask} />
              ) : (
                <OpBody ask={ask} />
              )}
              <CardText>{T("paneApproval.note")}</CardText>
            </CardBody>
          </ModalCard>
        );
      }}
    </Show>
  );
}
