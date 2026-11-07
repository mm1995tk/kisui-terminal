// 差分モードの CHANGES の一覧（ファイルエクスプローラの下）を描く。行を押す（Enter でも）と、そのファイルの差分を shj に出させる。
// shj が今差分を出しているファイルの行は強調する。見た目は changes.css。
import { For, Show, type JSX } from "solid-js";

import type { ChangeRow } from "./model.ts";
import "./changes.css";

/**
 * CHANGES の一覧。行を押す（Enter・Space でも）と onSelect を呼ぶ。
 * label は一覧の読み上げの名前、onSelect に渡す path は行の ChangeRow.path（shj が知らせた絶対パス）。
 */
export function ChangesView(props: {
  rows: ChangeRow[];
  label: string;
  onSelect: (path: string) => void;
}): JSX.Element {
  return (
    <section class="changes" aria-label={props.label}>
      <h3 class="changes-title">
        CHANGES<span class="changes-count">{props.rows.length}</span>
      </h3>
      <Show
        when={props.rows.length > 0}
        fallback={<p class="changes-empty">変更はありません</p>}
      >
        <div class="changes-list" role="listbox" aria-label={props.label}>
          <For each={props.rows}>
            {(r) => (
              <div
                class="changes-row"
                role="option"
                aria-selected={r.selected ? "true" : "false"}
                data-letter={r.letter}
                title={r.dir ? `${r.dir}/${r.name}` : r.name}
                tabIndex={0}
                onClick={() => props.onSelect(r.path)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    props.onSelect(r.path);
                  }
                }}
              >
                <span class="changes-name">{r.name}</span>
                <Show when={r.dir}>
                  <span class="changes-dir">{r.dir}</span>
                </Show>
                <Show when={r.added > 0}>
                  <span class="changes-added">+{r.added}</span>
                </Show>
                <Show when={r.deleted > 0}>
                  <span class="changes-deleted">-{r.deleted}</span>
                </Show>
                <span class="changes-mark" role="img" aria-label={r.label}>
                  {r.letter}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
