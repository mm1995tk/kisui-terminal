// DB の接続を選ぶ窓（リーダーの `d n`・サイドバーの「+」のメニューの「DB」。#347）。
// 窓がつないでいる全部のマシンの kisui serve から集めた接続を 1 つの一覧にし、どのマシンの接続かを右に出す。
// 選ぶと、その接続の DB のタブを開く。窓のキーは、ほかの一覧から選ぶ窓と同じ（machineList.ts の pickerKey）。決まりは docs/key-design.md。
import { T } from "../../../i18n/index.ts";
import { createSignal, For, Show, type JSX } from "solid-js";

import { basicHints } from "../../../features/commands/placeKeys.ts";
import type { DbPicker } from "../../../features/db/controller.ts";
import { connectionDetail, type DbChoice } from "../../../features/db/model.ts";
import { moveRow, pickerKey } from "../../../features/sessions/machineList.ts";
import { Button } from "../../components/Button.tsx";
import { CardBody, CardTitle, ModalCard } from "../../components/Card.tsx";
import { KeyFooter } from "../../components/KeyFooter.tsx";
import { openKeyList } from "../commands/KeyListDialog.tsx";

const rowId = (i: number) => `db-picker-row-${i}`;

/** 接続を選ぶ窓。j / k で選び、Enter かダブルクリックで onChoose、Esc かボタンで onCancel を呼ぶ。 */
export function DbConnectionPicker(props: {
  picker: DbPicker;
  onChoose: (c: DbChoice) => void;
  onCancel: () => void;
}): JSX.Element {
  const [index, setIndex] = createSignal(0);
  const choices = () => props.picker.choices;
  // 答えたマシンの分が後から足されても、ある行を選ぶ
  const at = () => Math.min(index(), Math.max(0, choices().length - 1));

  function onKeyDown(e: KeyboardEvent) {
    const k = pickerKey(e);
    if (!k) return;
    e.preventDefault();
    if (k.kind === "move") setIndex(moveRow(at(), k.to, choices().length));
    else if (k.kind === "help") openKeyList("picker");
    else {
      const c = choices()[at()];
      if (c) props.onChoose(c);
    }
  }

  return (
    <ModalCard
      label={T("db.picker.label")}
      width={640}
      onCancel={props.onCancel}
      header={<CardTitle>{T("db.picker.title")}</CardTitle>}
      footer={
        <KeyFooter
          items={basicHints({ decide: T("db.picker.open"), end: "cancel" })}
          actions={
            <Button onClick={props.onCancel}>{T("button.cancelAlt")}</Button>
          }
        />
      }
    >
      <div class="machine-dialog">
        <ul
          class="card-rows"
          tabIndex={0}
          role="listbox"
          aria-label={T("db.picker.label")}
          aria-busy={props.picker.loading ? "true" : undefined}
          aria-activedescendant={choices().length > 0 ? rowId(at()) : undefined}
          onKeyDown={onKeyDown}
          ref={(el) => queueMicrotask(() => el.focus())}
        >
          <For each={choices()}>
            {(c, i) => (
              <li
                id={rowId(i())}
                class="card-row machine-row"
                role="option"
                aria-selected={at() === i() ? "true" : "false"}
                title={connectionDetail(c.connection)}
                onClick={() => setIndex(i())}
                onDblClick={() => props.onChoose(c)}
              >
                <span class="card-row-name">
                  {c.connection.name}
                  <span class="machine-row-mark">
                    {connectionDetail(c.connection)}
                  </span>
                  <Show when={c.connection.readOnly}>
                    <span class="machine-row-mark">
                      {T("db.picker.readOnly")}
                    </span>
                  </Show>
                </span>
                <span class="card-row-state" style={{ color: c.color }}>
                  {c.machine}
                </span>
              </li>
            )}
          </For>
          <Show when={choices().length === 0}>
            <li class="card-empty" role="presentation">
              {props.picker.loading
                ? T("db.picker.loading")
                : T("db.picker.empty")}
            </li>
          </Show>
        </ul>
        <Show
          when={
            (!props.picker.loading && choices().length === 0) ||
            props.picker.notes.length > 0
          }
        >
          <CardBody>
            <Show when={!props.picker.loading && choices().length === 0}>
              <p class="card-text">{T("db.picker.emptyHint")}</p>
            </Show>
            <For each={props.picker.notes}>
              {(n) => <p class="card-text">{n}</p>}
            </For>
          </CardBody>
        </Show>
      </div>
    </ModalCard>
  );
}
