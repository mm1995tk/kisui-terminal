// DB のタブの結果の書き出しの窓（DB のタブの窓（リーダーの `a`）の `e`。#349・#458）。形（CSV・TSV・JSON）と書き出し先（クリップボード・ファイル）の組を、
// 1 つの一覧から選ぶ。窓のキーは、ほかの一覧から選ぶ窓と同じ（machineList.ts の pickerKey）。決まりは docs/key-design.md。
import { T } from "../../../i18n/index.ts";
import { createSignal, For, type JSX } from "solid-js";

import { basicHints } from "../../../features/commands/placeKeys.ts";
import type { DbExportAsk } from "../../../features/db/exportController.ts";
import {
  EXPORT_CHOICES,
  exportNoteKeys,
  type ExportChoice,
} from "../../../features/db/export.ts";
import { moveRow, pickerKey } from "../../../features/sessions/machineList.ts";
import { CardText, CardTitle, ModalCard } from "../../components/Card.tsx";
import { KeyFooter } from "../../components/KeyFooter.tsx";
import { openKeyList } from "../commands/KeyListDialog.tsx";

const rowId = (i: number) => `db-export-row-${i}`;

/** 書き出しの窓。j / k で選び、Enter かダブルクリックで onChoose、Esc かボタンで onCancel を呼ぶ。 */
export function DbExportDialog(props: {
  ask: DbExportAsk;
  onChoose: (c: ExportChoice) => void;
  onCancel: () => void;
}): JSX.Element {
  const [index, setIndex] = createSignal(0);

  function onKeyDown(e: KeyboardEvent) {
    const k = pickerKey(e);
    if (!k) return;
    e.preventDefault();
    if (k.kind === "move")
      setIndex(moveRow(index(), k.to, EXPORT_CHOICES.length));
    else if (k.kind === "help") openKeyList("picker");
    else props.onChoose(EXPORT_CHOICES[index()]!);
  }

  return (
    <ModalCard
      label={T("db.export.label")}
      width={480}
      onCancel={props.onCancel}
      header={
        <CardTitle>{T("db.export.title", { n: props.ask.rows })}</CardTitle>
      }
      footer={
        <KeyFooter
          items={basicHints({ decide: T("db.export.do"), end: "cancel" })}
        />
      }
    >
      <div class="machine-dialog">
        <For each={exportNoteKeys(props.ask)}>
          {(k) => <CardText role="note">{T(k)}</CardText>}
        </For>
        <ul
          class="card-rows"
          tabIndex={0}
          role="listbox"
          aria-label={T("db.export.label")}
          aria-activedescendant={rowId(index())}
          onKeyDown={onKeyDown}
          ref={(el) => queueMicrotask(() => el.focus())}
        >
          <For each={EXPORT_CHOICES}>
            {(c, i) => (
              <li
                id={rowId(i())}
                class="card-row machine-row"
                role="option"
                aria-selected={index() === i() ? "true" : "false"}
                onClick={() => setIndex(i())}
                onDblClick={() => props.onChoose(c)}
              >
                <span class="card-row-name">{c.format.toUpperCase()}</span>
                <span class="card-row-state">
                  {c.target === "clipboard"
                    ? T("db.export.clipboard")
                    : T("db.export.file")}
                </span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </ModalCard>
  );
}
