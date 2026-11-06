import { createSignal, Show } from "solid-js";

import { CopiedNotice } from "./copiedNotice.ts";

const [visible, setVisible] = createSignal(false);

/** 画面のどこからでも呼べる「コピーしました」（コピーに成功したときだけ呼ぶ）。 */
export const copiedNotice = new CopiedNotice(setVisible);

/** 画面の下の中央に出る「コピーしました」。copiedNotice.show() で出て、自分で消える。 */
export function CopiedToast() {
  return (
    <Show when={visible()}>
      <div class="copied-toast" role="status">
        コピーしました
      </div>
    </Show>
  );
}
