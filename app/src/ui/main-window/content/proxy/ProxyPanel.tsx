// プロキシのパネル（#409）。今出しているタブ（ターミナルのタブ・内蔵ブラウザのタブ）の通信の一覧と、選んだ通信の中身
// （要求と応答のヘッダーと本文）を、グリッドの場所の右側に出す。何を出すか・操作の中身は features/proxy/controller.ts。
// キーがパネルにある間のキーは、場所のキー（features/proxy/keys.ts。`?` の一覧は placeKeys.ts の proxy）。
import { createEffect, For, on, onCleanup, Show, type JSX } from "solid-js";

import { isHelpKey } from "../../../../features/commands/placeKeys.ts";
import type { ProxyPanelState } from "../../../../features/proxy/controller.ts";
import { proxyPanelKey } from "../../../../features/proxy/keys.ts";
import {
  formatDuration,
  formatSize,
  formatTime,
  flowUrl,
  statusKind,
  statusText,
} from "../../../../features/proxy/model.ts";
import { T } from "../../../../i18n/index.ts";
import type {
  ProxyBody,
  ProxyFlow,
} from "../../../../infrastructure/rpc/protocol.ts";
import { KeyHints } from "../../../components/KeyHints.tsx";
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

/** プロキシのパネル。 */
export function ProxyPanel(props: {
  panel: ProxyPanelState;
  /** タブのマシンの名前（ターミナルのタブのとき、どのマシンのプロキシかを出す） */
  machine: string;
  onSelect: (id: number) => void;
  onStep: (to: "next" | "prev" | "first" | "last") => void;
  onSide: (side?: "request" | "response") => void;
  /** キーをタブ（ターミナル・ページ）に戻す */
  onBack: () => void;
  onClose: () => void;
  /** キーの一覧（`?`）を出す */
  onHelp: () => void;
  /** パネルにキーを向ける関数を受け取る（消えるときは undefined） */
  focusRef: (focus: (() => void) | undefined) => void;
}): JSX.Element {
  let root!: HTMLDivElement;
  let list!: HTMLDivElement;
  props.focusRef(() => root?.focus());
  onCleanup(() => props.focusRef(undefined));

  const flows = () => props.panel.scope.flows;
  const selectedFlow = () => flows().find((f) => f.id === props.panel.selected);
  const detail = () => {
    const d = props.panel.detail;
    return d && d.id === props.panel.selected ? d : undefined;
  };

  // 選んだ行が見える所までスクロールする
  createEffect(
    on(
      () => props.panel.selected,
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
      () => flows().length,
      () => {
        if (props.panel.selected === undefined && list)
          list.scrollTop = list.scrollHeight;
      },
    ),
  );

  function onKeyDown(e: KeyboardEvent) {
    if (isHelpKey(e)) {
      e.preventDefault();
      props.onHelp();
      return;
    }
    const k = proxyPanelKey(e);
    if (k === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (k === "back") props.onBack();
    else if (k === "close") props.onClose();
    else if (k === "side") props.onSide();
    else props.onStep(k);
  }

  const row = (f: ProxyFlow) => (
    <tr
      class={styles.row}
      role="row"
      aria-selected={f.id === props.panel.selected}
      data-flow={f.id}
      title={f.error ? `${flowUrl(f)}\n${f.error}` : flowUrl(f)}
      onClick={() => props.onSelect(f.id)}
    >
      <td class={styles.cell}>{f.method}</td>
      <td class={`${styles.cell} ${styles.status}`} data-kind={statusKind(f)}>
        {statusText(f)}
      </td>
      <td class={styles.cell}>
        <span class={styles.host}>{f.host}</span>
        <span class={styles.path}>{f.path}</span>
      </td>
      <td class={styles.cell} data-kind="number">
        {f.state === "pending" ? "" : formatSize(f.respSize)}
      </td>
      <td class={styles.cell} data-kind="number">
        {f.state === "pending" ? "" : formatDuration(f.durationMs)}
      </td>
    </tr>
  );

  return (
    <div
      class={styles.root}
      ref={root}
      tabIndex={0}
      data-place="proxy"
      role="region"
      aria-label={T("proxy.title")}
      onKeyDown={onKeyDown}
    >
      <div class={styles.head}>
        <h2 class={styles.title}>{T("proxy.title")}</h2>
        <span class={styles.where}>
          {props.panel.subject.kind === "term"
            ? T("proxy.where.term", {
                machine: props.machine,
                port: props.panel.scope.port,
              })
            : T("proxy.where.browser", { port: props.panel.scope.port })}
        </span>
      </div>
      <div class={styles.list} ref={list}>
        <Show
          when={flows().length > 0}
          fallback={
            <p class={styles.note}>
              {props.panel.subject.kind === "term"
                ? T("proxy.empty.term")
                : T("proxy.empty.browser")}
            </p>
          }
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
              <For each={flows()}>{row}</For>
            </tbody>
          </table>
        </Show>
      </div>
      <div class={styles.detail}>
        <Show
          when={selectedFlow()}
          fallback={<p class={styles.note}>{T("proxy.detail.none")}</p>}
        >
          {(f) => (
            <>
              <div class={styles.tabs} role="tablist">
                <button
                  type="button"
                  class={styles.tab}
                  role="tab"
                  tabIndex={-1}
                  aria-selected={props.panel.side === "request"}
                  onClick={() => props.onSide("request")}
                >
                  {T("proxy.side.request")}
                </button>
                <button
                  type="button"
                  class={styles.tab}
                  role="tab"
                  tabIndex={-1}
                  aria-selected={props.panel.side === "response"}
                  onClick={() => props.onSide("response")}
                >
                  {T("proxy.side.response")}
                </button>
              </div>
              <div class={styles.content}>
                <p class={styles.line}>
                  {props.panel.side === "request"
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
                <Show when={detail()?.error}>
                  <p class={styles.error}>{detail()?.error}</p>
                </Show>
                <Show
                  when={detail()?.detail}
                  fallback={
                    <Show when={!detail()?.error}>
                      <p class={styles.note}>{T("proxy.detail.loading")}</p>
                    </Show>
                  }
                >
                  {(d) => (
                    <Show
                      when={props.panel.side === "request"}
                      fallback={
                        <Side headers={d().respHeaders} body={d().respBody} />
                      }
                    >
                      <Side headers={d().reqHeaders} body={d().reqBody} />
                    </Show>
                  )}
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>
      <div class={styles.foot}>
        <KeyHints
          items={[
            { keys: ["j", "k"], label: T("basic.select") },
            { keys: ["Tab"], label: T("proxy.hint.side") },
            { keys: ["?"], label: T("basic.help") },
            { keys: ["Esc"], label: T("proxy.hint.back") },
            { keys: ["q"], label: T("basic.close") },
          ]}
        />
      </div>
    </div>
  );
}
