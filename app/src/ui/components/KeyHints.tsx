// キー操作のヒント。窓の下の段・空のワークスペースの画面などで、「どのキーで何をするか」を同じ形で並べる。
// 1 つの項目は、キー（Kbd）を並べたあとに、何をするかの字。項目は横に流し、入りきらなければ次の行へ折り返す。
// 行の中に 1 つのキーだけを出すとき（閉じる確認の y・n など）は、Kbd だけを使う。
import { For, type JSX } from "solid-js";

import "./key-hints.css";

/** キー 1 つ。字はそのまま出す（Esc・Enter・j など） */
export function Kbd(props: { children: string }): JSX.Element {
  return <kbd class="kbd">{props.children}</kbd>;
}

/** ヒントの 1 項目。keys は続けて押すキー、または同じ操作のキーの組（j と k など） */
export interface KeyHint {
  keys: string[];
  label: string;
}

/** キー操作のヒントの並び。 */
export function KeyHints(props: { items: KeyHint[] }): JSX.Element {
  return (
    <ul class="key-hints">
      <For each={props.items}>
        {(h) => (
          <li class="key-hint">
            <span class="key-hint-keys">
              <For each={h.keys}>{(k) => <Kbd>{k}</Kbd>}</For>
            </span>
            {h.label}
          </li>
        )}
      </For>
    </ul>
  );
}
