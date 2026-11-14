// ワークスペースを作るマシンを選ぶ窓（リーダーの `w n`）。つながっているマシンを並べ、Enter で決める。
// 並べるのはつながっているマシンだけ（呼んだ側が選ぶ）。マシンが 1 つしか無ければ、呼んだ側がこの窓を出さずに作る。
// 窓のキーは machineList.ts の pickerKey、決まりは docs/key-design.md。
import { createMemo, createSignal, For, type JSX } from "solid-js";

import { ModalCard } from "./Card.tsx";
import { keepRow, moveRow, pickerKey, type MachineRow } from "./machineList.ts";

const rowId = (i: number) => `machine-picker-row-${i}`;

export function MachinePicker(props: {
  rows: MachineRow[];
  /** 開いたときに選んでおくマシン（今のマシン） */
  initial?: string;
  onChoose: (target: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [target, setTarget] = createSignal(props.initial);
  let last = 0;
  const index = createMemo(() => {
    last = keepRow(props.rows, target(), last);
    return last;
  });
  const move = (to: "next" | "prev" | "first" | "last") =>
    setTarget(props.rows[moveRow(index(), to, props.rows.length)]?.target);

  function onKeyDown(e: KeyboardEvent) {
    const k = pickerKey(e);
    if (!k) return;
    e.preventDefault();
    if (k.kind === "move") move(k.to);
    else {
      const r = props.rows[index()];
      if (r) props.onChoose(r.target);
    }
  }

  return (
    <ModalCard
      label="ワークスペースを作るマシン"
      width={560}
      onCancel={props.onCancel}
    >
      <div class="machine-dialog">
        <div class="card-body">
          <h1 class="card-title">どのマシンにワークスペースを作りますか</h1>
        </div>
        <ul
          class="card-rows"
          tabIndex={0}
          role="listbox"
          aria-label="マシンの一覧"
          aria-activedescendant={
            props.rows[index()] ? rowId(index()) : undefined
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
                aria-selected={index() === i() ? "true" : "false"}
                onClick={() => setTarget(r.target)}
                onDblClick={() => props.onChoose(r.target)}
              >
                <span
                  class="state-dot"
                  data-health={r.health}
                  aria-hidden="true"
                />
                <span class="card-row-name">{r.label}</span>
                <span class="card-row-state machine-row-count">
                  ワークスペース {r.workspaces}
                </span>
              </li>
            )}
          </For>
        </ul>
        <div class="card-body">
          <p class="machine-keys">
            <kbd>j</kbd> <kbd>k</kbd> 選ぶ・<kbd>Enter</kbd> 作る・
            <kbd>Esc</kbd> やめる
          </p>
        </div>
      </div>
      <div class="card-actions">
        <button type="button" class="card-button" onClick={props.onCancel}>
          やめる
        </button>
      </div>
    </ModalCard>
  );
}
