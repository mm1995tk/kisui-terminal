// リーダーの案内。リーダー（Mac は Cmd+K、Linux は Ctrl+Shift+K）を押すと、次に押せるキーとその動きを画面の右下に出す（which-key。
// shijimi-editor の Space の案内と同じ考え）。中身は、コマンドの表（commands.ts）の今の段の一覧そのもの。
// 一覧は押せず、フォーカスも取らない。キーは押した瞬間にフォーカスがあったペインに向いたまま。
// 実験的: 設定ファイルの `[gui] mascot` でキャラクターを選び、その `mascot.toml` が読めるときだけ、キャラクターが案内を運んでくる（MascotCarrier.tsx・docs/mascot.md）。
import { batch, createMemo, createSignal, For, Show, type JSX } from "solid-js";

import { leaderKeyName, menuRows, type Path } from "./commands.ts";
import { IS_MAC } from "./guiKeys.ts";
import styles from "./LeaderMenu.module.css";
import { MascotCarrier } from "./MascotCarrier.tsx";
import type { CloseReason } from "./mascot.ts";

const [leaderPath, setPath] = createSignal<Path | null>(null);
const [closedBy, setClosedBy] = createSignal<CloseReason>("other");

/**
 * リーダーに入っているときの木の中の位置（入っていなければ null）。App のキーの処理が書く。
 * 出るとき（`path` が null）は、`escaped`（Esc で出たか）で閉じ方も伝える（キャラクターが案内を押していくかを決める）。
 */
function setLeaderPath(path: Path | null, escaped = false): void {
  batch(() => {
    setClosedBy(path === null && escaped ? "escape" : "other");
    setPath(path);
  });
}

export { leaderPath, setLeaderPath };

/** リーダーの中のとき、次に押せるキーの一覧を出す。入っていなければ何も出さない。 */
export function LeaderMenu(): JSX.Element {
  let menuEl: HTMLDivElement | undefined;
  const open = createMemo(() => leaderPath() !== null);
  return (
    <>
      <MascotCarrier open={open} closedBy={closedBy} menu={() => menuEl} />
      <Show when={leaderPath()}>
        {(path) => {
          const rows = () => menuRows(path(), IS_MAC);
          return (
            <div
              ref={(e) => (menuEl = e)}
              class={styles.menu}
              data-overlay=""
              role="status"
              aria-label="リーダー"
            >
              <p class={styles.path}>
                {[leaderKeyName(IS_MAC), ...path()].join(" ")}
              </p>
              <ul class={styles.rows}>
                <For each={rows()}>
                  {(n) => (
                    <li class={styles.row}>
                      <kbd class={styles.key}>{n.keys}</kbd>
                      <span classList={{ [styles.group]: n.group }}>
                        {n.label}
                        {n.group ? " ›" : ""}
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
    </>
  );
}
