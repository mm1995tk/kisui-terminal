// ワークスペースを閉じるとき、プログラムが動いているターミナルがあれば出す確認の窓（Card.tsx の ModalCard）。
// 「終わらせて閉じる」と押されるまで何もしない。Esc は「やめる」。
import type { JSX } from "solid-js";

import { ModalCard } from "./Card.tsx";

/**
 * 動いているプログラムを終わらせて、ワークスペースを閉じてよいかを聞く窓。
 * 「終わらせて閉じる」で onYes、「やめる」と Esc で onNo を呼ぶ。ユーザーの操作で開くが、誤って
 * 打っていた Enter が押さないよう、フォーカスはボタンではなく窓そのものに置く。
 */
export function CloseWorkspaceCard(props: {
  /** ワークスペースの表示名 */
  name: string;
  onYes: () => void;
  onNo: () => void;
}): JSX.Element {
  return (
    <ModalCard label="ワークスペースを閉じるか" onCancel={props.onNo} focusSelf>
      <div class="card-body">
        <h1 class="card-title">動いているプログラムを終わらせますか？</h1>
        <p class="card-text">
          {props.name}{" "}
          のターミナルでプログラムが動いています。閉じると、ターミナルを全部終わらせます。開いているファイルは保存してから閉じます。
        </p>
      </div>
      <div class="card-actions">
        <button type="button" class="card-button" onClick={props.onNo}>
          やめる
        </button>
        <button type="button" class="card-button primary" onClick={props.onYes}>
          終わらせて閉じる
        </button>
      </div>
    </ModalCard>
  );
}
