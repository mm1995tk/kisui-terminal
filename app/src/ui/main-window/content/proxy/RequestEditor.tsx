// プロキシのパネル（#409）の下の段で、選んだ通信の要求を書き換えて送り直す欄（#410）。止めている要求（#411）なら、書き換えて流す。メソッド・URL・ヘッダー・本文を書き換え、
// Cmd+Enter（macOS）・Ctrl+Enter（ほか）で送る。何を送るか・送ったあとのことは features/proxy/controller.ts。
// 欄の中のキーは場所のキー（features/proxy/keys.ts の proxyEditKey。`?` の一覧は placeKeys.ts の proxyEdit）。
import { onCleanup, Show, type JSX } from "solid-js";

import type { ProxyEditState } from "../../../../features/proxy/controller.ts";
import { proxyEditKey } from "../../../../features/proxy/keys.ts";
import {
  formatSize,
  type ProxyDraft,
} from "../../../../features/proxy/model.ts";
import { T } from "../../../../i18n/index.ts";
import { Button } from "../../../components/Button.tsx";
import styles from "./ProxyPanel.module.css";

/** 要求を書き換える欄。 */
export function RequestEditor(props: {
  edit: ProxyEditState;
  mac: boolean;
  onDraft: (patch: Partial<Omit<ProxyDraft, "from">>) => void;
  onSend: () => void;
  onCancel: () => void;
  /** 欄にキーを向ける関数を受け取る（消えるときは undefined） */
  focusRef: (focus: (() => void) | undefined) => void;
}): JSX.Element {
  let url!: HTMLInputElement;
  props.focusRef(() => url?.focus());
  onCleanup(() => props.focusRef(undefined));

  const draft = () => props.edit.draft;
  /** 欄の題。止めている要求（#411）は、送り直すのではなく、書き換えて流す */
  const title = () =>
    props.edit.held
      ? T("proxy.edit.heldTitle", { id: draft().from })
      : T("proxy.edit.title", { id: draft().from });
  const sendKey = () => (props.mac ? "Cmd+Enter" : "Ctrl+Enter");

  function onKeyDown(e: KeyboardEvent) {
    // 欄の字（j k q ? など）は、パネルのキーにしない
    e.stopPropagation();
    const k = proxyEditKey(e, props.mac);
    if (k === null) return;
    e.preventDefault();
    if (k === "send") props.onSend();
    else props.onCancel();
  }

  const bodyNote = () => {
    const b = draft().body;
    switch (b.note) {
      case "binary":
        return T("proxy.edit.body.binary", { size: formatSize(b.size) });
      case "encoded":
        return T("proxy.edit.body.encoded", { size: formatSize(b.size) });
      case "cut":
        return T("proxy.edit.body.cut", { size: formatSize(b.size) });
      case "unread":
        return T("proxy.edit.body.unread");
    }
    return undefined;
  };

  return (
    <div
      class={styles.editor}
      data-place="proxyEdit"
      role="form"
      aria-label={title()}
      onKeyDown={onKeyDown}
    >
      <div class={styles.editHead}>
        <span class={styles.section}>{title()}</span>
        <span class={styles.editActions}>
          <Button onClick={props.onCancel}>{T("proxy.edit.cancel")}</Button>
          <Button
            variant="primary"
            busy={props.edit.sending}
            onClick={props.onSend}
          >
            {props.edit.sending
              ? T("proxy.edit.sending")
              : props.edit.held
                ? T("proxy.edit.forward", { key: sendKey() })
                : T("proxy.edit.send", { key: sendKey() })}
          </Button>
        </span>
      </div>
      <div class={styles.content}>
        <Show when={props.edit.error}>
          <p class={styles.error} role="alert">
            {props.edit.error}
          </p>
        </Show>
        <div class={styles.requestLine}>
          <input
            class={`${styles.input} ${styles.method}`}
            value={draft().method}
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            aria-label={T("proxy.edit.method")}
            onInput={(e) => props.onDraft({ method: e.currentTarget.value })}
          />
          <input
            ref={url}
            class={`${styles.input} ${styles.url}`}
            value={draft().url}
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            aria-label={T("proxy.edit.url")}
            onInput={(e) => props.onDraft({ url: e.currentTarget.value })}
          />
        </div>
        <Show when={draft().connectTo !== undefined}>
          <label class={styles.section} for="proxy-edit-connect-to">
            {T("proxy.edit.connectTo")}
          </label>
          <p class={styles.editNote}>{T("proxy.edit.connectToHint")}</p>
          <input
            id="proxy-edit-connect-to"
            class={styles.input}
            value={draft().connectTo ?? ""}
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            onInput={(e) => props.onDraft({ connectTo: e.currentTarget.value })}
          />
        </Show>
        <label class={styles.section} for="proxy-edit-headers">
          {T("proxy.headers")}
        </label>
        <textarea
          id="proxy-edit-headers"
          class={`${styles.input} ${styles.area}`}
          rows={6}
          value={draft().headers}
          spellcheck={false}
          autocapitalize="off"
          autocomplete="off"
          placeholder={T("proxy.edit.headersHint")}
          onInput={(e) => props.onDraft({ headers: e.currentTarget.value })}
        />
        <label class={styles.section} for="proxy-edit-body">
          {T("proxy.body")}
        </label>
        <Show when={bodyNote()}>
          {(note) => <p class={styles.editNote}>{note()}</p>}
        </Show>
        <Show when={draft().body.text !== undefined}>
          <textarea
            id="proxy-edit-body"
            class={`${styles.input} ${styles.area}`}
            rows={8}
            value={draft().body.text ?? ""}
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            onInput={(e) =>
              props.onDraft({
                body: { ...draft().body, text: e.currentTarget.value },
              })
            }
          />
        </Show>
      </div>
    </div>
  );
}
