import { createSignal, Show } from "solid-js";

import { CopiedNotice } from "./copiedNotice.ts";

const [visible, setVisible] = createSignal(false);
const [percent, setPercent] = createSignal(100);
const notice = new CopiedNotice(setVisible);

/** 表示の大きさ（#594）を変えたときに呼ぶ。少しの間だけ「90%」のように出す。 */
export function showScale(v: number): void {
  setPercent(Math.round(v * 100));
  notice.show();
}

/** 画面の右上に出る今の大きさ。showScale() で出て、自分で消える。 */
export function ScaleToast() {
  return (
    <Show when={visible()}>
      <div class="scale-toast" role="status">
        {percent()}%
      </div>
    </Show>
  );
}
