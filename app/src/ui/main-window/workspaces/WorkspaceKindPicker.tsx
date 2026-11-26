import { T } from "../../../i18n/index.ts";
import { createSignal, For, type JSX } from "solid-js";

import { KeyFooter } from "../../components/KeyFooter.tsx";
import { ModalCard, CardTitle } from "../../components/Card.tsx";
import { pickOnlyRows } from "../../../features/commands/placeKeys.ts";
import { openKeyList } from "../commands/KeyListDialog.tsx";
import { moveRow, pickerKey } from "../../../features/sessions/machineList.ts";

/** 作るワークスペースの種類。 */
export type WorkspaceKind = "terminal" | "browser";

const KINDS: readonly WorkspaceKind[] = ["terminal", "browser"];

const rowId = (i: number) => `kind-picker-row-${i}`;

/**
 * ワークスペースの種類（ターミナルかブラウザか）を選ぶ窓（リーダーの `w n`。内蔵ブラウザを有効にしているとき。#257）。
 * j / k で選び、Enter かダブルクリックで onChoose、Esc かボタンで onCancel を呼ぶ。
 * 窓のキーは、マシンを選ぶ窓（MachinePicker.tsx）と同じ（machineList.ts の pickerKey）。決まりは docs/key-design.md。
 */
export function WorkspaceKindPicker(props: {
  onChoose: (kind: WorkspaceKind) => void;
  onCancel: () => void;
}): JSX.Element {
  const [index, setIndex] = createSignal(0);
  const label = (k: WorkspaceKind) => T(`kindPicker.${k}`);

  function onKeyDown(e: KeyboardEvent) {
    const k = pickerKey(e);
    if (!k) return;
    e.preventDefault();
    if (k.kind === "move") setIndex((i) => moveRow(i, k.to, KINDS.length));
    else if (k.kind === "help") openKeyList("picker");
    else props.onChoose(KINDS[index()]);
  }

  return (
    <ModalCard
      label={T("kindPicker.label")}
      width={560}
      onCancel={props.onCancel}
      footer={<KeyFooter rows={pickOnlyRows(T("kindPicker.foot.kind"))} />}
      header={<CardTitle>{T("kindPicker.title")}</CardTitle>}
    >
      <div class="machine-dialog">
        <ul
          class="card-rows"
          tabIndex={0}
          role="listbox"
          aria-label={T("kindPicker.label")}
          aria-activedescendant={rowId(index())}
          onKeyDown={onKeyDown}
          ref={(el) => queueMicrotask(() => el.focus())}
        >
          <For each={KINDS}>
            {(k, i) => (
              <li
                id={rowId(i())}
                class="card-row machine-row"
                role="option"
                aria-selected={index() === i() ? "true" : "false"}
                onClick={() => setIndex(i())}
                onDblClick={() => props.onChoose(k)}
              >
                <span class="card-row-name">{label(k)}</span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </ModalCard>
  );
}
