// プロキシのパネル（#409）の上の段：通信の一覧。1 行が通信 1 つ（メソッド・状態・ホストとパス・大きさ・時間）。
import { createEffect, For, on, Show, type JSX } from "solid-js";

import {
  formatDuration,
  formatSize,
  flowUrl,
  statusKind,
  statusText,
} from "../../../../features/proxy/model.ts";
import { T } from "../../../../i18n/index.ts";
import type { ProxyFlow } from "../../../../infrastructure/rpc/protocol.ts";
import styles from "./ProxyPanel.module.css";

/** 通信の一覧。通信が無い間は empty の文を出す。 */
export function FlowList(props: {
  flows: readonly ProxyFlow[];
  /** 選んでいる通信の id */
  selected: number | undefined;
  /** まだ何も通っていないときに出す文 */
  empty: string;
  onSelect: (id: number) => void;
}): JSX.Element {
  let list!: HTMLDivElement;

  // 選んだ行が見える所までスクロールする
  createEffect(
    on(
      () => props.selected,
      (id) => {
        if (id === undefined) return;
        list
          ?.querySelector(`[data-flow="${id}"]`)
          ?.scrollIntoView({ block: "nearest" });
      },
    ),
  );
  // 何も選んでいない間は、新しい通信が見えるよう、下の端に付いていく
  createEffect(
    on(
      () => props.flows.length,
      () => {
        if (props.selected === undefined && list)
          list.scrollTop = list.scrollHeight;
      },
    ),
  );

  /** まだ終わっていない（応答の大きさと時間を出さない） */
  const waiting = (f: ProxyFlow) => f.state === "pending" || f.state === "held";

  const row = (f: ProxyFlow) => (
    <tr
      class={styles.row}
      role="row"
      aria-selected={f.id === props.selected}
      data-flow={f.id}
      data-held={f.state === "held" ? "" : undefined}
      title={
        f.state === "held"
          ? `${flowUrl(f)}\n${T("proxy.held.note")}`
          : f.error
            ? `${flowUrl(f)}\n${f.error}`
            : flowUrl(f)
      }
      onClick={() => props.onSelect(f.id)}
    >
      <td class={styles.cell}>
        {f.method}
        <Show when={f.resentFrom !== undefined}>
          <span
            class={styles.resent}
            title={T("proxy.resentFrom", { id: f.resentFrom ?? 0 })}
          >
            {" ↻"}
          </span>
        </Show>
        <Show when={f.edited}>
          <span class={styles.resent} title={T("proxy.edited")}>
            {" ✎"}
          </span>
        </Show>
      </td>
      <td class={`${styles.cell} ${styles.status}`} data-kind={statusKind(f)}>
        {statusText(f)}
      </td>
      <td class={styles.cell}>
        <span class={styles.host}>{f.host}</span>
        <span class={styles.path}>{f.path}</span>
      </td>
      <td class={styles.cell} data-kind="number">
        {waiting(f) ? "" : formatSize(f.respSize)}
      </td>
      <td class={styles.cell} data-kind="number">
        {waiting(f) ? "" : formatDuration(f.durationMs)}
      </td>
    </tr>
  );

  return (
    <div class={styles.list} ref={list}>
      <Show
        when={props.flows.length > 0}
        fallback={<p class={styles.note}>{props.empty}</p>}
      >
        <table class={styles.table} role="grid">
          <colgroup>
            <col style={{ width: "8ch" }} />
            <col style={{ width: "8ch" }} />
            <col />
            <col style={{ width: "9ch" }} />
            <col style={{ width: "8ch" }} />
          </colgroup>
          <thead>
            <tr>
              <th class={styles.th}>{T("proxy.col.method")}</th>
              <th class={styles.th}>{T("proxy.col.status")}</th>
              <th class={styles.th}>{T("proxy.col.url")}</th>
              <th class={styles.th} data-kind="number">
                {T("proxy.col.size")}
              </th>
              <th class={styles.th} data-kind="number">
                {T("proxy.col.time")}
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={props.flows}>{row}</For>
          </tbody>
        </table>
      </Show>
    </div>
  );
}
