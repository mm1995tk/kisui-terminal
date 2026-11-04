// shj が無いマシンに入れてよいかを聞く窓（C6）。何を・どこから・どこへ入れるかを見せ、
// 「入れる」と押されるまで何もしない。Esc は「入れない」。
import { Show, type JSX } from "solid-js";

import type { SessionState } from "../ssh/session.ts";
import { ModalCard } from "./Card.tsx";

/**
 * shj が無いマシン（target）に、GUI と同じ版の shj を入れてよいかを聞く窓。
 * 入れる版・取ってくる所・入れる先（state.plan）と、前に失敗した理由（state.error）を見せる。
 * 「入れる」で onYes、「入れない」と Esc で onNo を呼ぶ。起動時の自動接続でも開くので、
 * フォーカスはボタンではなく窓そのものに置く（打っていた Enter で入れ始めないように）。
 */
export function InstallCard(props: {
  /** マシンの表示名 */
  target: string;
  state: Extract<SessionState, { kind: "needs-install" }>;
  onYes: () => void;
  onNo: () => void;
}): JSX.Element {
  return (
    <ModalCard label="shj を入れるか" onCancel={props.onNo} focusSelf>
      <div class="card-body">
        <h1 class="card-title">{props.target} に shj を入れますか？</h1>
        <p class="card-text">
          {props.target} に shj がありません。GUI と同じ版（
          {props.state.plan.version}）の shj を GitHub Releases（
          {props.state.plan.release_url}）から取り、{props.target} の{" "}
          <code>{props.state.plan.path}</code> に入れます。
        </p>
        <p class="card-text">
          取った実行ファイルは SHA-256
          を確かめてから使い、合わなければ入れません。PATH の shj
          には触りません。
        </p>
        <Show when={props.state.error}>
          <pre class="card-error" role="alert">
            {props.state.error}
          </pre>
        </Show>
      </div>
      <div class="card-actions">
        <button type="button" class="card-button" onClick={props.onNo}>
          入れない
        </button>
        <button type="button" class="card-button primary" onClick={props.onYes}>
          入れる
        </button>
      </div>
    </ModalCard>
  );
}
