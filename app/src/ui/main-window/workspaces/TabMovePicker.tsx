import { T } from "../../../i18n/index.ts";
import { createSignal, For, type JSX } from "solid-js";

import { moveRow, pickerKey } from "../../../features/sessions/machineList.ts";
import type { Row } from "../../../features/workspaces/rows.ts";
import { Button } from "../../components/Button.tsx";
import { ModalCard, CardTitle } from "../../components/Card.tsx";
import { KeyFooter } from "../../components/KeyFooter.tsx";
import { basicHints } from "../../../features/commands/placeKeys.ts";
import { openKeyList } from "../commands/KeyListDialog.tsx";

const rowId = (i: number) => `tab-move-row-${i}`;

/**
 * タブを移す先のワークスペースを選ぶ窓（リーダーの `t m`。#308）。rows のワークスペース（今のワークスペースを除いたもの。
 * 除くのは呼んだ側）を、サイドバーと同じ並びで出す。空のワークスペースも並ぶ。j / k で選び、Enter かダブルクリックで onChoose、
 * Esc かボタンで onCancel を呼ぶ。窓のキーは、マシンを選ぶ窓（MachinePicker.tsx）と同じ（machineList.ts の pickerKey）。決まりは docs/key-design.md。
 */
export function TabMovePicker(props: {
  /** 移すタブの名前 */
  title: string;
  /** 移す先に選べるワークスペース */
  rows: readonly Row[];
  onChoose: (gws: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [index, setIndex] = createSignal(0);
  // 出している間に行が減っても（ほかの GUI がワークスペースを閉じたなど）、ある行を選ぶ
  const at = () => Math.min(index(), Math.max(0, props.rows.length - 1));

  function onKeyDown(e: KeyboardEvent) {
    const k = pickerKey(e);
    if (!k) return;
    e.preventDefault();
    if (k.kind === "move") setIndex(moveRow(at(), k.to, props.rows.length));
    else if (k.kind === "help") openKeyList("picker");
    else {
      const r = props.rows[at()];
      if (r) props.onChoose(r.gws);
    }
  }

  return (
    <ModalCard
      label={T("tabMove.label")}
      width={560}
      onCancel={props.onCancel}
      header={
        <CardTitle>{T("tabMove.title", { title: props.title })}</CardTitle>
      }
      footer={
        <KeyFooter
          items={basicHints({ decide: T("tabMove.keys.move"), end: "cancel" })}
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
          aria-label={T("tabMove.label")}
          aria-activedescendant={
            props.rows.length > 0 ? rowId(at()) : undefined
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
                aria-selected={at() === i() ? "true" : "false"}
                onClick={() => setIndex(i())}
                onDblClick={() => props.onChoose(r.gws)}
              >
                <span class="card-row-name">{r.band.title}</span>
                <span
                  class="switch-count"
                  title={T("switcher.tabCount", { n: r.tabs.items.length })}
                >
                  {r.tabs.items.length}
                </span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </ModalCard>
  );
}
