// DB の権限を、時間を決めて一時的に強める Dialog（DB のタブの Dialog（リーダーの `a`）の `p`。#383・#458）。出している DB のタブの接続（の変種）の、強められる権限
// （自分のもの・コーディングエージェントのもの）を並べ、選んだものを、打った時間の間だけ強める。強めてよいか・上限の時間は
// kisui serve のマシンの設定（権限の elevate-to・elevate-max）が決め、時間の字を読むのも kisui serve（features/db/elevateController.ts）。
import { T } from "../../../i18n/index.ts";
import { createSignal, For, Show, type JSX } from "solid-js";

import { basicHints } from "../../../features/commands/placeKeys.ts";
import {
  durationText,
  remainingText,
  type DbActor,
  type ElevateRow,
} from "../../../features/db/elevate.ts";
import type { DbElevateAsk } from "../../../features/db/elevateController.ts";
import { dbElevateKey } from "../../../features/db/keys.ts";
import "../../components/card.css";
import {
  CardBody,
  CardError,
  CardText,
  CardTitle,
  ModalCard,
} from "../../components/Card.tsx";
import { Field, Input } from "../../components/Field.tsx";
import { KeyHints } from "../../components/KeyHints.tsx";

/** 行の見出し：誰の権限か。 */
const who = (actor: DbActor) =>
  T(actor === "human" ? "db.elevate.row.human" : "db.elevate.row.agent");

/**
 * 強める Dialog。↓ ↑（Ctrl+J / Ctrl+K）で強める権限を選び、時間を打って Enter で onSubmit（誰の権限を、どの時間）、Esc で onCancel を呼ぶ。
 * 時間の入力欄には、選んだ権限の上限を初めから入れておく（打ち替えるまでは、選ぶ行に合わせて替わる）。
 */
export function DbElevateDialog(props: {
  ask: DbElevateAsk;
  onSubmit: (actor: DbActor, duration: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const rows = () => props.ask.rows ?? [];
  const [sel, setSel] = createSignal(0);
  /** 打ち替えた時間（打ち替えるまでは undefined：選んだ権限の上限を出す） */
  const [typed, setTyped] = createSignal<string>();
  const row = (): ElevateRow | undefined =>
    rows()[Math.min(sel(), rows().length - 1)];
  const time = () => typed() ?? durationText(row()?.maxSeconds ?? 0);

  function submit() {
    const r = row();
    if (r) props.onSubmit(r.actor, time());
  }

  function onKeyDown(e: KeyboardEvent) {
    const k = dbElevateKey(e);
    if (!k) return;
    e.preventDefault();
    if (k.kind === "step")
      setSel((i) => Math.min(rows().length - 1, Math.max(0, i + k.step)));
    else submit();
  }

  return (
    <ModalCard
      label={T("db.elevate.label")}
      onCancel={props.onCancel}
      header={
        <CardTitle>
          {T("db.elevate.title", { connection: props.ask.connection })}
        </CardTitle>
      }
      status={
        <Show when={props.ask.error}>
          {(error) => <CardError role="alert">{error()}</CardError>}
        </Show>
      }
      footer={
        <KeyHints
          items={basicHints({
            select: ["↓", "↑", "Ctrl+J", "Ctrl+K"],
            decide: T("db.elevate.do"),
            help: false,
            end: "cancel",
          })}
        />
      }
    >
      <CardBody>
        <CardText>{T("db.elevate.text")}</CardText>
      </CardBody>
      <Show
        when={rows().length > 0}
        fallback={<p class="card-empty">{T("db.elevate.loading")}</p>}
      >
        <ul class="card-rows" role="listbox" aria-label={T("db.elevate.list")}>
          <For each={rows()}>
            {(r, i) => (
              <li role="presentation">
                <button
                  type="button"
                  class="card-row"
                  role="option"
                  tabIndex={-1}
                  aria-selected={r === row()}
                  // 入力欄からフォーカスを動かさない（押したあとも ↑ ↓ と Enter が効くように）
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => setSel(i())}
                >
                  <span class="card-row-name">
                    {who(r.actor)}
                    {": "}
                    {T("db.elevate.row.detail", {
                      from: r.from,
                      to: r.to,
                      run: r.run,
                    })}
                  </span>
                  <span class="card-row-state">
                    {r.remainingSeconds !== undefined
                      ? `${T("db.elevate.row.on", { time: remainingText(r.remainingSeconds) })} · `
                      : ""}
                    {T("db.elevate.row.max", {
                      max: durationText(r.maxSeconds),
                    })}
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
        <CardBody>
          <Field>
            <span class="card-text">{T("db.elevate.time")}</span>
            <Input
              type="text"
              autocomplete="off"
              spellcheck={false}
              placeholder={T("db.elevate.timePlaceholder")}
              aria-label={T("db.elevate.time")}
              value={time()}
              onInput={(e) => setTyped(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              ref={(el) =>
                queueMicrotask(() => {
                  el.focus();
                  el.select();
                })
              }
            />
          </Field>
        </CardBody>
      </Show>
    </ModalCard>
  );
}
