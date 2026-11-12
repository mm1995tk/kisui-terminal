// CHANGES の木の 1 行（フォルダか、変更のあるファイル）を描く。キーの操作は ChangesView と actions.ts。
import { Show, type JSX } from "solid-js";

import type { ChangeEntry } from "./model.ts";

/**
 * CHANGES の木の 1 行：フォルダ（開閉の矢印・名前・中のファイルの数）か、変更のあるファイル（名前・PR モードだけ viewed のチェックボックス・+n・-n・印 M/A/D/R/B）。
 * aria-selected は shj が今差分を出しているファイルの行。data-holds は、閉じたフォルダの中にそのファイルがあるフォルダの行
 * （space E でキーを向ける先。changesRow が探す）。
 * onPress は行をクリックしたとき、onKeyDown は行にフォーカスがあるときのキー（割り当ては ChangesView が keys.ts で決める）。
 */
export function ChangeTreeRow(props: {
  entry: ChangeEntry;
  onPress: () => void;
  onKeyDown: (e: KeyboardEvent & { currentTarget: HTMLElement }) => void;
}): JSX.Element {
  const en = () => props.entry;
  const r = () => en().row;
  return (
    <div
      class="changes-row"
      role="treeitem"
      aria-level={en().depth + 1}
      aria-expanded={en().kind === "dir" ? en().expanded : undefined}
      aria-selected={r()?.selected ? "true" : "false"}
      data-kind={en().kind}
      data-letter={r()?.letter}
      data-key={en().key}
      data-place="changes"
      // 差分を出しているファイルが、閉じたこのフォルダの中にある（space E でここに向ける）
      data-holds={en().holdsSelected ? "true" : undefined}
      style={{ "--changes-depth": String(en().depth) }}
      title={en().key}
      tabIndex={0}
      onClick={() => props.onPress()}
      onKeyDown={(e) => props.onKeyDown(e)}
    >
      <Show
        when={en().kind === "dir"}
        fallback={<span class="changes-chevron" />}
      >
        <svg
          class="changes-chevron"
          width="12"
          height="12"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path d={en().expanded ? "M4 6l4 4 4-4" : "M6 4l4 4-4 4"} />
        </svg>
      </Show>
      <span class="changes-name">{en().name}</span>
      <Show when={en().kind === "dir"}>
        <span class="changes-dircount">{en().count}</span>
      </Show>
      <Show when={r()}>
        {(row) => (
          <>
            <Show when={row().viewed !== undefined}>
              <span
                class="changes-viewed"
                role="checkbox"
                aria-checked={row().viewed ? "true" : "false"}
                aria-readonly="true"
                aria-label="確認済み"
              >
                {row().viewed ? "[x]" : "[ ]"}
              </span>
            </Show>
            <Show when={row().added > 0}>
              <span class="changes-added">+{row().added}</span>
            </Show>
            <Show when={row().deleted > 0}>
              <span class="changes-deleted">-{row().deleted}</span>
            </Show>
            <span class="changes-mark" role="img" aria-label={row().label}>
              {row().letter}
            </span>
          </>
        )}
      </Show>
    </div>
  );
}
