// kisui が無いマシンに入れてよいかを聞く窓（C6）。何を・どこから・どこへ入れるかを見せ、
// 「入れる」と押されるまで何もしない。Esc は「入れない」。
import { T } from "../../../i18n/index.ts";
import { Show, type JSX } from "solid-js";

import type { SessionState } from "../../../features/sessions/session.ts";
import { Button } from "../../components/Button.tsx";
import { ModalCard } from "../../components/Card.tsx";

/**
 * kisui が無いマシン（target）に、GUI と同じ版の kisui を入れてよいかを聞く窓。
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
    <ModalCard label={T("installCard.label")} onCancel={props.onNo} focusSelf>
      <div class="card-body">
        <h1 class="card-title">
          {T("installCard.title", { target: props.target })}
        </h1>
        <p class="card-text">
          {T("installCard.text", {
            target: props.target,
            version: props.state.plan.version,
            url: props.state.plan.release_url,
            path: props.state.plan.path,
          })}
        </p>
        <p class="card-text">{T("installCard.verify")}</p>
        <Show when={props.state.error}>
          <pre class="card-error" role="alert">
            {props.state.error}
          </pre>
        </Show>
      </div>
      <div class="card-actions">
        <Button onClick={props.onNo}>{T("installCard.no")}</Button>
        <Button variant="primary" onClick={props.onYes}>
          {T("installCard.yes")}
        </Button>
      </div>
    </ModalCard>
  );
}
