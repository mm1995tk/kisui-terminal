// 空のワークスペース（タブが 1 つも無い。#307）を選んでいる間に、右のペインに出す画面。
// タブが無いことと、タブを足す・ワークスペースを閉じるキー（どれもリーダーの木にある操作）を伝える。
// ほかのワークスペースのターミナルは出さず、キーも送らない。キーはこの画面そのものに置く（リーダーと近道は窓が受ける）。
import { T } from "../../../i18n/index.ts";
import { For, Show, onCleanup, type JSX } from "solid-js";

import styles from "./EmptyWorkspace.module.css";

/** 空のワークスペースの画面。leader はリーダーのキー（この OS の書き方）。browser は内蔵ブラウザを使うか（ブラウザのタブを足すキーを出すか）。 */
export function EmptyWorkspace(props: {
  leader: string;
  browser: boolean;
  /** この画面にキーを向ける関数を受け取る（消えるときは undefined） */
  focusRef?: (f: (() => void) | undefined) => void;
}): JSX.Element {
  let el!: HTMLDivElement;
  props.focusRef?.(() => el.focus());
  onCleanup(() => props.focusRef?.(undefined));
  const keys = (...k: string[]) => [props.leader, ...k];
  return (
    <div
      class={styles.empty}
      ref={el}
      tabIndex={-1}
      role="region"
      aria-label={T("emptyWorkspace.title")}
    >
      <div class={styles.inner}>
        <h1 class={styles.title}>{T("emptyWorkspace.title")}</h1>
        <p class={styles.text}>{T("emptyWorkspace.text")}</p>
        <dl class={styles.keys}>
          <Keys keys={keys("t", "n")} label={T("emptyWorkspace.addTerminal")} />
          <Show when={props.browser}>
            <Keys
              keys={keys("o", "n")}
              label={T("emptyWorkspace.addBrowser")}
            />
          </Show>
          <Keys
            keys={keys("w", "x")}
            label={T("emptyWorkspace.closeWorkspace")}
          />
        </dl>
        <p class={styles.text}>{T("emptyWorkspace.plus")}</p>
      </div>
    </div>
  );
}

/** キーの並び 1 行（左にキー、右に何をするか）。 */
function Keys(props: { keys: string[]; label: string }): JSX.Element {
  return (
    <>
      <dt>
        <For each={props.keys}>{(k) => <kbd>{k}</kbd>}</For>
      </dt>
      <dd>{props.label}</dd>
    </>
  );
}
