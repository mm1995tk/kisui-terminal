// リーダーの案内。リーダー（Mac は Cmd+K、Linux は Ctrl+Shift+K）を押すと、次に押せるキーとその動きを画面の左下に出す（which-key。
// shijimi-editor の Space の案内と同じ考え）。中身は、コマンドの表（commands.ts）の今の段の一覧そのもの。
// 一覧は押せず、フォーカスも取らない。キーは押した瞬間にフォーカスがあったペインに向いたまま。
import { createSignal, For, Show, type JSX } from "solid-js";

import { childrenAt, leaderKeyName, nodeKeys, type Path } from "./commands.ts";
import { IS_MAC } from "./guiKeys.ts";
import styles from "./LeaderMenu.module.css";

const [leaderPath, setLeaderPath] = createSignal<Path | null>(null);

/** リーダーに入っているときの木の中の位置（入っていなければ null）。App のキーの処理が書く。 */
export { leaderPath, setLeaderPath };

/** リーダーの中のとき、次に押せるキーの一覧を出す。入っていなければ何も出さない。 */
export function LeaderMenu(): JSX.Element {
  return (
    <Show when={leaderPath()}>
      {(path) => {
        const rows = () => childrenAt(path()) ?? [];
        return (
          <div class={styles.menu} role="status" aria-label="リーダー">
            <p class={styles.path}>
              {[leaderKeyName(IS_MAC), ...path()].join(" ")}
            </p>
            <ul class={styles.rows}>
              <For each={rows()}>
                {(n) => (
                  <li class={styles.row}>
                    <kbd class={styles.key}>{nodeKeys(n)}</kbd>
                    <span classList={{ [styles.group]: n.type === "group" }}>
                      {n.label}
                      {n.type === "group" ? " ›" : ""}
                    </span>
                  </li>
                )}
              </For>
            </ul>
            <p class={styles.foot}>
              Esc で出る{path().length > 0 ? " ・ Backspace で一段戻る" : ""}
            </p>
          </div>
        );
      }}
    </Show>
  );
}
