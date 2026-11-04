// マシンの名前を変える窓（見出しの右クリックの「名前を変える」で出す）。
// 空にして決めると、名前を外して ssh の行き先に戻す。決められなかった理由（ほかのマシンと同じ名前）は error に出す。
import { createSignal, Show, type JSX } from "solid-js";

import { ModalCard } from "./Card.tsx";

export function RenameMachine(props: {
  /** 今の名前（付けていなければ ssh の行き先） */
  current: string;
  /** 名前が空のときに戻る先（ssh の行き先） */
  target: string;
  error?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [name, setName] = createSignal(props.current);
  return (
    <ModalCard label="名前を変える" onCancel={props.onCancel}>
      <div class="card-body">
        <h1 class="card-title">名前を変える</h1>
        <label class="card-field">
          名前
          <input
            class="card-input"
            type="text"
            placeholder={`空なら ${props.target}`}
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                props.onSubmit(name());
              }
            }}
            ref={(el) => queueMicrotask(() => el.select())}
            autofocus
          />
        </label>
        <Show when={props.error}>
          {(e) => (
            <pre class="card-error" role="alert">
              {e()}
            </pre>
          )}
        </Show>
      </div>
      <div class="card-actions">
        <button type="button" class="card-button" onClick={props.onCancel}>
          キャンセル
        </button>
        <button
          type="button"
          class="card-button primary"
          onClick={() => props.onSubmit(name())}
        >
          変える
        </button>
      </div>
    </ModalCard>
  );
}
