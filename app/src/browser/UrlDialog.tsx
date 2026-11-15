// 内蔵ブラウザ（#202）の URL の入力欄。リーダーの o n（新しいタブ）・o N（シークレットのタブ。#204）と o u（今のタブの URL を書き換える）で出す。
// scheme を省くと https（localhost などは http）で開く。開けない URL（http と https 以外など）は、窓の中に理由を出す。
import { T } from "../i18n/index.ts";
import { createSignal, Show, type JSX } from "solid-js";

import { ModalCard } from "../connect/Card.tsx";
import { normalizeUrl } from "./tabs.ts";

/**
 * URL の入力欄のダイアログ（リーダーの o n・o u）。決めると、開ける形に直した URL で onSubmit を呼ぶ。
 * 開けない URL なら、ダイアログの中に理由を出して閉じない。
 */
export function UrlDialog(props: {
  /** 新しいタブか、今のタブの URL を書き換えるか */
  kind: "new" | "edit";
  /** シークレットのタブを開く（#204） */
  incognito?: boolean;
  /** 入力欄の初めの値（書き換えるときは今の URL） */
  initial: string;
  onSubmit: (url: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [value, setValue] = createSignal(props.initial);
  const [error, setError] = createSignal<string | undefined>();
  const title = () =>
    props.kind === "edit"
      ? T("urlDialog.edit")
      : props.incognito
        ? T("urlDialog.incognito")
        : T("urlDialog.new");
  function submit() {
    const u = normalizeUrl(value());
    if (u === null) {
      setError(T("urlDialog.invalid"));
      return;
    }
    props.onSubmit(u);
  }
  return (
    <ModalCard label={title()} onCancel={props.onCancel}>
      <div class="card-body">
        <h1 class="card-title">{title()}</h1>
        <label class="card-field">
          URL
          <input
            class="card-input"
            type="text"
            inputmode="url"
            spellcheck={false}
            autocomplete="off"
            placeholder="https://example.com"
            value={value()}
            onInput={(e) => {
              setValue(e.currentTarget.value);
              setError(undefined);
            }}
            onKeyDown={(e) => {
              if (e.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            ref={(el) => queueMicrotask(() => el.select())}
            autofocus
          />
        </label>
        <Show when={error()}>
          {(e) => (
            <p class="card-error" role="alert">
              {e()}
            </p>
          )}
        </Show>
      </div>
      <div class="card-actions">
        <button type="button" class="card-button" onClick={props.onCancel}>
          {T("button.cancel")}
        </button>
        <button type="button" class="card-button primary" onClick={submit}>
          {T("download.open")}
        </button>
      </div>
    </ModalCard>
  );
}
