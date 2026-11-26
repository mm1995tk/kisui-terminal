// 空のワークスペース（タブが 1 つも無い。#307）を選んでいる間に、右のペインに出す画面。
// タブが無いことと、タブを足す・ワークスペースを閉じるキーを伝える。タブを足すキーは、リーダーの `n` で開くワークスペースの窓の、
// 作るタブの種類の字（`t` ターミナル・`b` ブラウザ・`d` DB。#456）。閉じるのは、リーダーの `w` で開く窓の `x`。
// ほかのワークスペースのターミナルは出さず、キーも送らない。キーはこの画面そのものに置く（リーダーと近道は窓が受ける）。
import { T } from "../../../i18n/index.ts";
import { onCleanup, type JSX } from "solid-js";

import { KeyHints } from "../../components/KeyHints.tsx";
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
        <KeyHints
          items={[
            { keys: keys("n", "t"), label: T("emptyWorkspace.addTerminal") },
            ...(props.browser
              ? [
                  {
                    keys: keys("n", "b"),
                    label: T("emptyWorkspace.addBrowser"),
                  },
                ]
              : []),
            { keys: keys("n", "d"), label: T("emptyWorkspace.addDb") },
            {
              keys: keys("w", "x"),
              label: T("emptyWorkspace.closeWorkspace"),
            },
          ]}
        />
        <p class={styles.text}>{T("emptyWorkspace.plus")}</p>
      </div>
    </div>
  );
}
