// プロキシのパネル（#409）の下の段：選んだ通信の中身。「要求」と「応答」を切り替えて、ヘッダーと本文を出す。
import { For, Show, type JSX } from "solid-js";

import type {
  ProxyDetailState,
  ProxySide,
} from "../../../../features/proxy/controller.ts";
import {
  formatDuration,
  formatSize,
  formatTime,
  flowUrl,
  statusText,
} from "../../../../features/proxy/model.ts";
import { T } from "../../../../i18n/index.ts";
import type {
  ProxyBody,
  ProxyFlow,
} from "../../../../infrastructure/rpc/protocol.ts";
import styles from "./ProxyPanel.module.css";

/** 本文 1 つ。字として読めなければ、その旨と大きさだけを出す。 */
function Body(props: { body: ProxyBody }): JSX.Element {
  return (
    <Show
      when={props.body.size > 0}
      fallback={<p class={styles.note}>{T("proxy.body.empty")}</p>}
    >
      <Show
        when={props.body.text !== undefined}
        fallback={
          <p class={styles.note}>
            {props.body.encoding
              ? T("proxy.body.encoded", {
                  encoding: props.body.encoding,
                  size: formatSize(props.body.size),
                })
              : T("proxy.body.binary", { size: formatSize(props.body.size) })}
          </p>
        }
      >
        <pre class={styles.body}>{props.body.text}</pre>
        <Show when={props.body.truncated}>
          <p class={styles.note}>
            {T("proxy.body.truncated", { size: formatSize(props.body.size) })}
          </p>
        </Show>
      </Show>
    </Show>
  );
}

/** ヘッダーの並びと本文（要求か応答の片側）。 */
function Side(props: {
  headers: [string, string][];
  body: ProxyBody;
}): JSX.Element {
  return (
    <>
      <h3 class={styles.section}>{T("proxy.headers")}</h3>
      <dl class={styles.headers}>
        <For each={props.headers}>
          {([name, value]) => (
            <div class={styles.header}>
              <dt class={styles.name}>{name}:</dt>
              <dd class={styles.value}>{value}</dd>
            </div>
          )}
        </For>
      </dl>
      <h3 class={styles.section}>{T("proxy.body")}</h3>
      <Body body={props.body} />
    </>
  );
}

/** 「要求」「応答」の切り替えの 1 つ。 */
function SideTab(props: {
  label: string;
  selected: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      class={styles.tab}
      role="tab"
      tabIndex={-1}
      aria-selected={props.selected}
      onClick={() => props.onClick()}
    >
      {props.label}
    </button>
  );
}

/**
 * 選んだ通信 flow の中身。detail は読んだ中身（読んでいる間は、detail も error も無い。その通信のものだけを渡す）。
 */
export function FlowDetail(props: {
  flow: ProxyFlow;
  detail: ProxyDetailState | undefined;
  side: ProxySide;
  onSide: (side: ProxySide) => void;
}): JSX.Element {
  const f = () => props.flow;
  return (
    <>
      <div class={styles.tabs} role="tablist">
        <SideTab
          label={T("proxy.side.request")}
          selected={props.side === "request"}
          onClick={() => props.onSide("request")}
        />
        <SideTab
          label={T("proxy.side.response")}
          selected={props.side === "response"}
          onClick={() => props.onSide("response")}
        />
      </div>
      <div class={styles.content}>
        <Show when={props.side === "request" && f().resentFrom !== undefined}>
          <p class={`${styles.line} ${styles.resent}`}>
            {T("proxy.resentFrom", { id: f().resentFrom ?? 0 })}
          </p>
        </Show>
        <p class={styles.line}>
          {props.side === "request"
            ? `${f().method} ${flowUrl(f())}`
            : `${statusText(f())} · ${formatTime(f().time)}${
                f().state === "pending"
                  ? ""
                  : ` · ${formatDuration(f().durationMs)}`
              }`}
        </p>
        <Show when={f().error}>
          <p class={styles.error}>{f().error}</p>
        </Show>
        <Show when={props.detail?.error}>
          <p class={styles.error}>{props.detail?.error}</p>
        </Show>
        <Show
          when={props.detail?.detail}
          fallback={
            <Show when={!props.detail?.error}>
              <p class={styles.note}>{T("proxy.detail.loading")}</p>
            </Show>
          }
        >
          {(d) => (
            <Show
              when={props.side === "request"}
              fallback={<Side headers={d().respHeaders} body={d().respBody} />}
            >
              <Side headers={d().reqHeaders} body={d().reqBody} />
            </Show>
          )}
        </Show>
      </div>
    </>
  );
}
