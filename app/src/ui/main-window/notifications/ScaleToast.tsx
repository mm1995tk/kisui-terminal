import { createSignal, Show } from "solid-js";

import styles from "./ScaleToast.module.css";
import { TimedNotice } from "./timedNotice.ts";

const [visible, setVisible] = createSignal(false);
const [percent, setPercent] = createSignal(100);
const notice = new TimedNotice(setVisible);

/** 表示の大きさ（#594）を変えたときに呼ぶ。少しの間だけ「90%」のように出す。 */
export function showScale(v: number): void {
  setPercent(Math.round(v * 100));
  notice.show();
}

/**
 * 画面の右上に出る今の大きさ。showScale() で出て、自分で消える。
 * overPage のときは、内蔵ブラウザのページ（子の webview）の下に隠れないよう、画面の下の中央に出し、ページの上に重なる印
 * （data-overlay）を付ける（ui/main-window/content/browser/overlay.ts）。macOS 以外では、ページは下の端だけを上げて避けるので、
 * 右上のままではページが丸ごと隠れる。
 */
export function ScaleToast(props: {
  /** 内蔵ブラウザのページを出しているか */
  overPage?: boolean;
}) {
  return (
    <Show when={visible()}>
      <div
        class={
          props.overPage ? `${styles.toast} ${styles.overPage}` : styles.toast
        }
        role="status"
        data-overlay={props.overPage ? "" : undefined}
      >
        {percent()}%
      </div>
    </Show>
  );
}
