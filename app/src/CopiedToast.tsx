import { T } from "./i18n/index.ts";
import { createSignal, Show } from "solid-js";

import styles from "./CopiedToast.module.css";
import { TimedNotice } from "./timedNotice.ts";

const [visible, setVisible] = createSignal(false);
/** 出す文。無ければ「コピーしました」 */
const [text, setText] = createSignal<string | undefined>();
const notice = new TimedNotice(setVisible);

/** 画面のどこからでも呼べる「コピーしました」（コピーに成功したときだけ呼ぶ）。 */
export const copiedNotice = {
  show(): void {
    setText(undefined);
    notice.show();
  },
};

/** 同じ場所に、ほかの短い知らせ（「ブックマークに足しました」。#205）を出す。 */
export function showToast(message: string): void {
  setText(message);
  notice.show();
}

/**
 * 画面の下の中央に出る「コピーしました」などの短い知らせ。copiedNotice.show()・showToast() で出て、自分で消える。
 * overPage のときは、内蔵ブラウザのページ（子の webview）が避ける印（data-overlay-shrink）を付ける。付けないとページの下に隠れる。
 */
export function CopiedToast(props: {
  /** 内蔵ブラウザのページを出しているか */
  overPage?: boolean;
}) {
  return (
    <Show when={visible()}>
      <div
        class={styles.toast}
        role="status"
        data-overlay-shrink={props.overPage ? "" : undefined}
      >
        {text() ?? T("toast.copied")}
      </div>
    </Show>
  );
}
