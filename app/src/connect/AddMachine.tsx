// リモートを足す窓（左の一覧の一番下の「+ リモートを足す」と、マシンのダイアログ（リーダーの m）の a で出す）。
// ssh の行き先は、~/.ssh/config のホストの候補から選ぶか、打って入れる（打った文字で候補を絞る）。
// 名前は空なら ssh の行き先を使う。「足す」で ssh につなぎ、つながったら呼んだ側がマシンを保存して窓を閉じる。
// つないでいる最中は入力を止めて状態を出し、つなげなければ理由を出して、直して足し直せるようにする。
import { isComposingKey } from "../ime.ts";
import { T } from "../i18n/index.ts";
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";

import type { SessionState } from "../ssh/session.ts";
import { ModalCard } from "./Card.tsx";
import { listStep } from "../placeKeys.ts";
import { filterCandidates } from "../ssh/machines.ts";
import { stateLabel } from "./status.ts";

/** 行の id（入力欄の aria-activedescendant で、選んでいる行を読み上げに伝える）。 */
const optionId = (i: number) => `add-machine-option-${i}`;

/**
 * リモートを足す窓。candidates は ~/.ssh/config のホストのうち、まだ足していないもの。
 * onSubmit は「足す」で呼ぶ（入れた行き先と名前をそのまま渡す。確かめるのは呼んだ側）。
 * busy の間（つないでいる最中）は入力と「足す」を止める。state はそのときの接続の状態。
 * error は直前に足せなかった理由。onCancel は「キャンセル」と Esc で呼ぶ。
 */
export function AddMachine(props: {
  candidates: string[];
  busy: boolean;
  state?: SessionState;
  error?: string;
  onSubmit: (target: string, name: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [target, setTarget] = createSignal("");
  const [name, setName] = createSignal("");
  const [active, setActive] = createSignal<number | undefined>();
  const shown = createMemo(() => filterCandidates(props.candidates, target()));

  function pick(t: string) {
    setTarget(t);
    setActive(undefined);
  }
  function move(step: number) {
    const n = shown().length;
    if (n === 0) return;
    const cur = active();
    setActive(
      cur === undefined ? (step > 0 ? 0 : n - 1) : (cur + step + n) % n,
    );
  }
  function submit() {
    if (props.busy) return;
    props.onSubmit(target(), name());
  }

  return (
    <ModalCard label={T("addMachine.title")} onCancel={props.onCancel}>
      <div class="card-body">
        <h1 class="card-title">{T("addMachine.title")}</h1>
        <label class="card-field">
          {T("addMachine.target")}
          <input
            class="card-input"
            type="text"
            role="combobox"
            aria-expanded={shown().length > 0 ? "true" : "false"}
            aria-autocomplete="list"
            aria-controls="add-machine-options"
            aria-activedescendant={
              active() !== undefined ? optionId(active()!) : undefined
            }
            placeholder={T("addMachine.targetPlaceholder")}
            value={target()}
            disabled={props.busy}
            spellcheck={false}
            autocapitalize="off"
            onInput={(e) => {
              setTarget(e.currentTarget.value);
              setActive(undefined);
            }}
            onKeyDown={(e) => {
              if (isComposingKey(e)) return;
              // ↓ ↑ か Ctrl+J / Ctrl+K で候補を動かす（入力欄に字を打つので、j k は使えない）
              const step =
                e.key === "ArrowDown"
                  ? 1
                  : e.key === "ArrowUp"
                    ? -1
                    : listStep(e);
              if (step !== 0) {
                e.preventDefault();
                move(step);
              } else if (e.key === "Enter") {
                e.preventDefault();
                const i = active();
                if (i !== undefined && shown()[i] !== undefined)
                  pick(shown()[i]);
                else submit();
              }
            }}
            autofocus
          />
        </label>
      </div>
      <Show when={shown().length > 0}>
        <div class="card-section" id="add-machine-list">
          {T("addMachine.candidates")}
        </div>
        <ul
          id="add-machine-options"
          class="card-rows"
          role="listbox"
          aria-labelledby="add-machine-list"
        >
          <For each={shown()}>
            {(t, i) => (
              <li role="presentation">
                <button
                  type="button"
                  id={optionId(i())}
                  class="card-row"
                  role="option"
                  disabled={props.busy}
                  aria-selected={active() === i() ? "true" : "false"}
                  onClick={() => pick(t)}
                >
                  <span class="card-row-name">{t}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="card-body">
        <label class="card-field">
          {T("addMachine.name")}
          <input
            class="card-input"
            type="text"
            placeholder={T("addMachine.namePlaceholder")}
            value={name()}
            disabled={props.busy}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (isComposingKey(e)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
        </label>
        <Show when={props.busy}>
          <p class="card-text" role="status">
            {T("addMachine.busy", {
              state: stateLabel(props.state) || T("addMachine.connecting"),
            })}
          </p>
        </Show>
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
          {T("button.cancel")}
        </button>
        <button
          type="button"
          class="card-button primary"
          disabled={props.busy}
          onClick={submit}
        >
          {T("addMachine.add")}
        </button>
      </div>
    </ModalCard>
  );
}
