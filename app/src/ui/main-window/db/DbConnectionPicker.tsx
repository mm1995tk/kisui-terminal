// DB の接続を選ぶ Dialog（Workspace switcher の、作るタブの種類（リーダーの `n`）の「DB」・サイドバーの「+」のメニューの「DB」。#347）。
// Window がつないでいる全部のマシンの kisui serve から集めた接続を 1 つの一覧にし、どのマシンの接続かを右に出す。
// 環境の変種のある接続は、変種ごとに 1 行（`接続 (変種)`）：接続と変種を、この一覧で 1 回で選ぶ。
// 選ぶと、その接続の DB のタブを開く。動かす・決めるキーは、ほかの一覧から選ぶ Dialog と同じ（machineList.ts の pickerKey）。
// a・e・d で、この PC の config.local.toml の接続を足す・直す・消す（#486。features/db/pickerKeys.ts）。直せない行では、理由を Key footer に出す。
// config.local.toml で登録している行には印を付ける（上書きを消すと config.toml の接続に戻り、印が外れる）。
// 決まりは docs/key-design.md。
import { T } from "../../../i18n/index.ts";
import { createEffect, createSignal, For, on, Show, type JSX } from "solid-js";

import {
  localMark,
  rowEditNote,
  rowEditState,
  type LocalDbConnections,
} from "../../../features/db/connectionForm.ts";
import type { DbPicker } from "../../../features/db/controller.ts";
import { connectionDetail, type DbChoice } from "../../../features/db/model.ts";
import {
  dbPickerFooter,
  dbPickerKey,
} from "../../../features/db/pickerKeys.ts";
import { dbLabel } from "../../../features/workspaces/model.ts";
import { moveRow } from "../../../features/sessions/machineList.ts";
import {
  CardBody,
  CardText,
  CardTitle,
  ModalCard,
} from "../../components/Card.tsx";
import { KeyFooter } from "../../components/KeyFooter.tsx";
import { openKeyList } from "../commands/KeyListDialog.tsx";

const rowId = (i: number) => `db-picker-row-${i}`;

/**
 * 接続を選ぶ Dialog。j / k で選び、Enter かダブルクリックで onChoose、Esc かボタンで onCancel を呼ぶ。
 * a は onAdd、e・d は選んでいる行で onEdit・onRemove を呼ぶ（直せない行では呼ばない）。local は手元の PC の設定（読めていなければ undefined）、
 * localError はそれを読めなかった理由。editing の間（足す・直す・消す Dialog を上に出している間）はキーを受けず、閉じたら一覧にキーを戻す。
 */
export function DbConnectionPicker(props: {
  picker: DbPicker;
  local: LocalDbConnections | undefined;
  localError?: string | undefined;
  editing: boolean;
  onChoose: (c: DbChoice) => void;
  onAdd: () => void;
  onEdit: (c: DbChoice | undefined) => void;
  onRemove: (c: DbChoice | undefined) => void;
  onCancel: () => void;
}): JSX.Element {
  const [index, setIndex] = createSignal(0);
  const choices = () => props.picker.choices;
  // 答えたマシンの分が後から足されても、ある行を選ぶ
  const at = () => Math.min(index(), Math.max(0, choices().length - 1));
  const editState = () => rowEditState(choices()[at()], props.local);
  let list: HTMLUListElement | undefined;
  createEffect(
    on(
      () => props.editing,
      (now, before) => {
        if (before && !now) list?.focus();
      },
    ),
  );

  function onKeyDown(e: KeyboardEvent) {
    if (props.editing) return;
    const k = dbPickerKey(e);
    if (!k) return;
    e.preventDefault();
    if (k.kind === "move") setIndex(moveRow(at(), k.to, choices().length));
    else if (k.kind === "help") openKeyList("dbPicker");
    else if (k.kind === "add") props.onAdd();
    else if (k.kind === "edit") props.onEdit(choices()[at()]);
    else if (k.kind === "remove") props.onRemove(choices()[at()]);
    else {
      const c = choices()[at()];
      if (c) props.onChoose(c);
    }
  }

  /** 選んでいる行を直せない理由（行が無い・直せるなら無し） */
  const note = () =>
    choices().length === 0 ? undefined : rowEditNote(editState());

  return (
    <ModalCard
      label={T("db.picker.label")}
      width={640}
      onCancel={props.onCancel}
      header={<CardTitle>{T("db.picker.title")}</CardTitle>}
      footer={
        <KeyFooter
          note={<Show when={note()}>{(n) => <CardText>{n()}</CardText>}</Show>}
          rows={dbPickerFooter({
            editable: editState().kind === "edit",
            removable:
              editState().kind === "edit" || editState().kind === "removeOnly",
          })}
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
          ref={(el) => {
            list = el;
            queueMicrotask(() => el.focus());
          }}
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
                  {dbLabel(c.connection.name, c.connection.variant)}
                  <span class="machine-row-mark">
                    {connectionDetail(c.connection)}
                  </span>
                  <Show when={localMark(c, props.local)}>
                    <span class="machine-row-mark">
                      {T("dbConn.mark.local")}
                    </span>
                  </Show>
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
            props.picker.notes.length > 0 ||
            props.localError
          }
        >
          <CardBody>
            <Show when={!props.picker.loading && choices().length === 0}>
              <p class="card-text">{T("db.picker.emptyHint")}</p>
            </Show>
            <For each={props.picker.notes}>
              {(n) => <p class="card-text">{n}</p>}
            </For>
            <Show when={props.localError}>
              {(e) => <p class="card-text">{e()}</p>}
            </Show>
          </CardBody>
        </Show>
      </div>
    </ModalCard>
  );
}
