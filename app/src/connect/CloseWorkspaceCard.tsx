// ワークスペースを閉じるとき、プログラムが動いているターミナルがあれば出す確認の窓（Card.tsx の ModalCard）。
// 「終わらせて閉じる」と押されるまで何もしない。Esc は「やめる」。
import { T } from "../i18n/index.ts";
import type { JSX } from "solid-js";

import { ModalCard } from "./Card.tsx";

/**
 * 動いているプログラムを終わらせて、ワークスペースを閉じてよいかを聞く窓。
 * 「終わらせて閉じる」で onYes、「やめる」と Esc で onNo を呼ぶ。ユーザーの操作で開くが、誤って
 * 打っていた Enter が押さないよう、フォーカスはボタンではなく窓そのものに置く。
 */
export function CloseWorkspaceCard(props: {
  /** ワークスペース（tab なら、ターミナルのタブ）の表示名 */
  name: string;
  /** 閉じるのがターミナルのタブ 1 つのとき "tab"（文が変わる）。省くとワークスペース */
  kind?: "workspace" | "tab";
  onYes: () => void;
  onNo: () => void;
}): JSX.Element {
  return (
    <ModalCard
      label={T(
        props.kind === "tab" ? "closeTab.label" : "closeWorkspace.label",
      )}
      onCancel={props.onNo}
      focusSelf
    >
      <div class="card-body">
        <h1 class="card-title">
          {T(props.kind === "tab" ? "closeTab.title" : "closeWorkspace.title")}
        </h1>
        <p class="card-text">
          {T(props.kind === "tab" ? "closeTab.text" : "closeWorkspace.text", {
            name: props.name,
          })}
        </p>
      </div>
      <div class="card-actions">
        <button type="button" class="card-button" onClick={props.onNo}>
          {T("button.cancelAlt")}
        </button>
        <button type="button" class="card-button primary" onClick={props.onYes}>
          {T("closeWorkspace.yes")}
        </button>
      </div>
    </ModalCard>
  );
}
