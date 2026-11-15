import { T } from "../i18n/index.ts";
import { For, type JSX } from "solid-js";

import { ModalCard } from "./Card.tsx";
import { pickerKey, type MachineRow } from "./machineList.ts";
import { createRowSelection } from "./rowSelection.ts";

const rowId = (i: number) => `machine-picker-row-${i}`;

/**
 * ワークスペースを作るマシンを選ぶ窓（リーダーの `w n`）。rows のマシンを並べ、j / k で選び、Enter かダブルクリックで
 * onChoose、Esc かボタンで onCancel を呼ぶ。並べるのはつながっているマシンだけで、それを選ぶのは呼んだ側。
 * マシンが 1 つしか無ければ、呼んだ側がこの窓を出さずに作る。窓のキーは machineList.ts の pickerKey、決まりは docs/key-design.md。
 */
export function MachinePicker(props: {
  rows: MachineRow[];
  /** 開いたときに選んでおくマシン（今のマシン） */
  initial?: string;
  onChoose: (target: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const sel = createRowSelection(() => props.rows, props.initial);

  function onKeyDown(e: KeyboardEvent) {
    const k = pickerKey(e);
    if (!k) return;
    e.preventDefault();
    if (k.kind === "move") sel.move(k.to);
    else {
      const r = sel.selected();
      if (r) props.onChoose(r.target);
    }
  }

  return (
    <ModalCard label={T("picker.label")} width={560} onCancel={props.onCancel}>
      <div class="machine-dialog">
        <div class="card-body">
          <h1 class="card-title">{T("picker.title")}</h1>
        </div>
        <ul
          class="card-rows"
          tabIndex={0}
          role="listbox"
          aria-label={T("machineDialog.list")}
          aria-activedescendant={
            sel.selected() ? rowId(sel.index()) : undefined
          }
          onKeyDown={onKeyDown}
          ref={(el) => queueMicrotask(() => el.focus())}
        >
          <For each={props.rows}>
            {(r, i) => (
              <li
                id={rowId(i())}
                class="card-row machine-row"
                role="option"
                aria-selected={sel.index() === i() ? "true" : "false"}
                onClick={() => sel.pick(i())}
                onDblClick={() => props.onChoose(r.target)}
              >
                <span
                  class="state-dot"
                  data-health={r.health}
                  aria-hidden="true"
                />
                <span class="card-row-name">{r.label}</span>
              </li>
            )}
          </For>
        </ul>
        <div class="card-body">
          <p class="machine-keys">
            <kbd>j</kbd> <kbd>k</kbd> {T("machineDialog.keys.select")} ·{" "}
            <kbd>Enter</kbd> {T("picker.keys.create")} · <kbd>Esc</kbd>{" "}
            {T("mascot.keys.cancel")}
          </p>
        </div>
      </div>
      <div class="card-actions">
        <button type="button" class="card-button" onClick={props.onCancel}>
          {T("button.cancelAlt")}
        </button>
      </div>
    </ModalCard>
  );
}
