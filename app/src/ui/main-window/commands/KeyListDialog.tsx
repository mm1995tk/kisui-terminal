// 全部のキーの一覧（リーダーの `?`）。コマンドの表（commands.ts）から作るので、実際に受けるキーとずれない。
// 左はリーダーを押してから押すキー、右はリーダーを通さずに 1 回で押せる近道（この OS のもの）。
import { T } from "../../../i18n/index.ts";
import { createSignal, For, Show, type JSX } from "solid-js";

import {
  helpRows,
  leaderKeyName,
} from "../../../features/commands/commands.ts";
import { ModalCard } from "../../components/Card.tsx";
import { IS_MAC } from "../../../features/commands/guiKeys.ts";
import {
  PLACE_KEYS,
  type Place,
} from "../../../features/commands/placeKeys.ts";
import styles from "./KeyListDialog.module.css";

const [opened, setOpened] = createSignal(false);
const [place, setPlace] = createSignal<Place | undefined>();

/**
 * 一覧を開く。place を渡すと、その場所のキーを先に出す（場所のキーの `?`と、リーダーの `?` を押したときにフォーカスがある場所。
 * docs/key-design.md の 3.3）。
 */
export function openKeyList(first?: Place): void {
  setPlace(first);
  setOpened(true);
}

/** 一覧の窓。開いていなければ何も出さない。Esc で閉じる。 */
export function KeyListDialog(): JSX.Element {
  const leader = leaderKeyName(IS_MAC);
  const outside = IS_MAC ? "Option+Space" : "Alt+Space";
  return (
    <Show when={opened()}>
      <ModalCard
        label={T("keys.label")}
        width={640}
        onCancel={() => setOpened(false)}
        focusSelf
      >
        <div class={styles.body}>
          <h1 class={styles.title}>{T("keys.label")}</h1>
          <section class={styles.part}>
            <p class={styles.lead}>{T("keys.lead", { leader })}</p>
            <table class={styles.table}>
              <thead>
                <tr>
                  <th>{T("keys.col.after", { leader })}</th>
                  <th>{T("keys.col.action")}</th>
                  <th>{T("keys.col.shortcut")}</th>
                </tr>
              </thead>
              <tbody>
                <For each={helpRows(IS_MAC)}>
                  {(r) => (
                    <tr classList={{ [styles.groupRow]: r.group }}>
                      <td class={styles.keys}>{r.path.join(" ")}</td>
                      <td style={{ "padding-left": `${8 + r.depth * 12}px` }}>
                        {r.label}
                        {r.group ? " ›" : ""}
                      </td>
                      <td class={styles.shortcut}>{r.shortcut ?? ""}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </section>
          <Show when={place()}>
            {(pl) => (
              <section class={`${styles.part} ${styles.first}`}>
                <h2 class={styles.subtitle}>{PLACE_KEYS[pl()].title}</h2>
                <Show when={PLACE_KEYS[pl()].lead}>
                  <p class={styles.lead}>{PLACE_KEYS[pl()].lead}</p>
                </Show>
                <table class={styles.table}>
                  <tbody>
                    <For each={PLACE_KEYS[pl()].rows}>
                      {(r) => (
                        <tr>
                          <td class={styles.keys}>{r.keys}</td>
                          <td>{r.label}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </section>
            )}
          </Show>
          <p class={styles.outside}>{T("keys.outside", { key: outside })}</p>
        </div>
        <div class="card-actions">
          <button
            type="button"
            class="card-button primary"
            onClick={() => setOpened(false)}
          >
            {T("button.close")}
          </button>
        </div>
      </ModalCard>
    </Show>
  );
}
