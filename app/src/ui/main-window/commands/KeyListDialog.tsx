// キーの一覧（`?`）。コマンドの表（commands.ts）と場所のキーの表（placeKeys.ts）から作るので、実際に受けるキーとずれない。
// リーダーの `?` と、ペインの場所（ファイルツリー・CHANGES・動画・画像）の `?` は、全部のキーを出す
// （左はリーダーを押してから押すキー、右はリーダーを通さずに 1 回で押せる近道（この OS のもの）。場所のキーがあれば先に出す）。
// 窓（マシンのダイアログ・切り替える窓・選ぶ窓・ブックマーク・履歴）の `?` は、その窓のキーだけを出す
// （窓が出ている間は、リーダーに入れないため）。閉じると、下の窓の、開く前にフォーカスがあった所へ戻る（ModalCard）。
import { T } from "../../../i18n/index.ts";
import { createSignal, For, Show, type JSX } from "solid-js";

import {
  helpRows,
  leaderKeyName,
} from "../../../features/commands/commands.ts";
import { Button } from "../../components/Button.tsx";
import { ModalCard, CardActions } from "../../components/Card.tsx";
import { IS_MAC } from "../../../features/commands/guiKeys.ts";
import {
  isWindowPlace,
  PLACE_KEYS,
  type Place,
} from "../../../features/commands/placeKeys.ts";
import styles from "./KeyListDialog.module.css";

const [opened, setOpened] = createSignal(false);
const [places, setPlaces] = createSignal<readonly Place[]>([]);

/**
 * 一覧を開く。場所を渡すと、その場所のキーを先に出す（場所のキーの `?`と、リーダーの `?` を押したときにフォーカスがある場所。
 * docs/key-design.md の 3.3）。窓の場所（placeKeys.ts の isWindowPlace）なら、その窓のキーだけを出す。
 * 並びで渡すと、その順に出す（切り替える窓の 2 つの列）。
 */
export function openKeyList(first?: Place | readonly Place[]): void {
  setPlaces(
    first === undefined ? [] : typeof first === "string" ? [first] : first,
  );
  setOpened(true);
}

/** 場所 1 つのキーの表。 */
function PlaceSection(props: { place: Place }): JSX.Element {
  const pl = () => PLACE_KEYS[props.place];
  return (
    <section class={`${styles.part} ${styles.first}`}>
      <h2 class={styles.subtitle}>{pl().title}</h2>
      <Show when={pl().lead}>
        <p class={styles.lead}>{pl().lead}</p>
      </Show>
      <table class={styles.table}>
        <tbody>
          <For each={pl().rows}>
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
  );
}

/** 一覧の窓。開いていなければ何も出さない。Esc で閉じる。 */
export function KeyListDialog(): JSX.Element {
  const leader = leaderKeyName(IS_MAC);
  const outside = IS_MAC ? "Option+Space" : "Alt+Space";
  /** 窓の `?` か（その窓のキーだけを出す） */
  const windowOnly = () => places().some(isWindowPlace);
  return (
    <Show when={opened()}>
      <ModalCard
        label={T("keys.label")}
        width={640}
        onCancel={() => setOpened(false)}
        focusSelf
        header={<h1 class={styles.title}>{T("keys.label")}</h1>}
        footer={
          <CardActions>
            <Button variant="primary" onClick={() => setOpened(false)}>
              {T("button.close")}
            </Button>
          </CardActions>
        }
      >
        <div class={styles.body}>
          <For each={places()}>{(p) => <PlaceSection place={p} />}</For>
          <Show when={!windowOnly()}>
            <section
              class={styles.part}
              role="table"
              aria-label={T("keys.label")}
              aria-describedby="key-list-lead"
            >
              {/* 説明文と列見出しは、下の一覧をスクロールしても上に残す（sticky）。見出しと行は同じ 3 列の grid で、幅がそろう */}
              <div class={styles.stick}>
                <p id="key-list-lead" class={styles.lead}>
                  {T("keys.lead", { leader })}
                </p>
                <div class={`${styles.row} ${styles.head}`} role="row">
                  <span role="columnheader">
                    {T("keys.col.after", { leader })}
                  </span>
                  <span role="columnheader">{T("keys.col.action")}</span>
                  <span role="columnheader">{T("keys.col.shortcut")}</span>
                </div>
              </div>
              <div role="rowgroup">
                <For each={helpRows(IS_MAC)}>
                  {(r) => (
                    <div
                      class={styles.row}
                      classList={{ [styles.groupRow]: r.group }}
                      role="row"
                    >
                      <span class={styles.keys} role="cell">
                        {r.path.join(" ")}
                      </span>
                      <span
                        role="cell"
                        style={{ "padding-left": `${r.depth * 12}px` }}
                      >
                        {r.label}
                        {r.group ? " ›" : ""}
                      </span>
                      <span class={styles.shortcut} role="cell">
                        {r.shortcut ?? ""}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </section>
            <p class={styles.outside}>{T("keys.outside", { key: outside })}</p>
          </Show>
        </div>
      </ModalCard>
    </Show>
  );
}
