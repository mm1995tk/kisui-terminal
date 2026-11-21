// DB のタブの木の上で、接続の既定のスキーマを選ぶ所（#398）。木の `s` か、既定のスキーマの欄を押すと、その欄の場所で開く
// （窓は出さない）。欄が絞り込みの入力欄になり、その下にスキーマの一覧が出る。
// キーはクエリの履歴の窓（ui/main-window/db/DbHistoryDialog.tsx）と同じ：字を打って絞り込み、↓ ↑・Ctrl+J / Ctrl+K で選び、
// Enter かクリックで決め、Esc で閉じる。ほかの所を押してフォーカスが外れても閉じる。
import { T } from "../../../../i18n/index.ts";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type JSX,
} from "solid-js";

import { isComposingKey } from "../../../../features/commands/ime.ts";
import { dbHistoryKey } from "../../../../features/db/keys.ts";
import styles from "./DbTree.module.css";

/** 選択肢の字（null は「DB の既定」） */
export const schemaOptionLabel = (o: string | null) =>
  o ?? T("db.tree.schema.dbDefault");

/** 既定のスキーマを選ぶ所。options は schemaPrefs.ts の schemaChoices の並び、selected は今選ばれているもの。 */
export function DbSchemaPicker(props: {
  options: readonly (string | null)[];
  selected: string | null;
  onChoose: (option: string | null) => void;
  onCancel: () => void;
}): JSX.Element {
  let box: HTMLDivElement | undefined;
  let list: HTMLUListElement | undefined;
  const [query, setQuery] = createSignal("");
  const shown = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q === ""
      ? props.options
      : props.options.filter((o) =>
          schemaOptionLabel(o).toLowerCase().includes(q),
        );
  });
  // 開いたときは、今選ばれているものを選んでおく
  const [sel, setSel] = createSignal(
    Math.max(0, props.options.indexOf(props.selected)),
  );
  const selectedIndex = () => Math.min(sel(), shown().length - 1);

  createEffect(() => {
    const i = selectedIndex();
    queueMicrotask(() =>
      list?.children[i]?.scrollIntoView?.({ block: "nearest" }),
    );
  });

  function choose(i = selectedIndex()) {
    const o = shown()[i];
    if (o !== undefined) props.onChoose(o);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && !isComposingKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      props.onCancel();
      return;
    }
    // キーは履歴の窓と同じ（? は使わない）
    const k = dbHistoryKey(e, false);
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    if (k.kind === "step")
      setSel((i) => Math.min(shown().length - 1, Math.max(0, i + k.step)));
    else if (k.kind === "choose") choose();
  }

  return (
    <div
      ref={box}
      class={styles.picker}
      onFocusOut={(e) => {
        // この中のほかの所へ移ったのでなければ閉じる
        const to = e.relatedTarget as Node | null;
        if (!to || !box?.contains(to)) props.onCancel();
      }}
    >
      <input
        class={styles.field}
        type="text"
        placeholder={schemaOptionLabel(props.selected)}
        aria-label={T("db.schemaPicker.filter")}
        role="combobox"
        aria-expanded="true"
        aria-controls="db-schema-picker-list"
        aria-activedescendant={
          shown().length > 0 ? `db-schema-${selectedIndex()}` : undefined
        }
        autocomplete="off"
        spellcheck={false}
        // value は渡さない：打つたびに value を入れ直すと、WebKit でかな漢字変換中の字が重なって増える
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          setSel(0);
        }}
        onKeyDown={onKeyDown}
        ref={(el) => queueMicrotask(() => el.focus())}
      />
      <Show
        when={shown().length > 0}
        fallback={<p class={styles.note}>{T("db.schemaPicker.noMatch")}</p>}
      >
        <ul
          id="db-schema-picker-list"
          ref={list}
          class={styles.pickerList}
          role="listbox"
          aria-label={T("db.schemaPicker.list")}
        >
          <For each={shown()}>
            {(o, i) => (
              <li
                id={`db-schema-${i()}`}
                class={styles.pickerRow}
                role="option"
                aria-selected={i() === selectedIndex()}
                // 入力欄からフォーカスを動かさない（押しても閉じず、↓ ↑ と Enter が効くまま）
                onMouseDown={(ev) => ev.preventDefault()}
                onMouseMove={() => setSel(i())}
                onClick={() => choose(i())}
              >
                <span class={styles.schemaName}>{schemaOptionLabel(o)}</span>
                <Show when={o === props.selected}>
                  <span class={styles.badge}>
                    {T("db.schemaPicker.current")}
                  </span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
