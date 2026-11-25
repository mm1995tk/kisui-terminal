// プロキシのパネル（#409）。今出しているタブ（ターミナルのタブ・内蔵ブラウザのタブ）の通信の一覧（FlowList.tsx）と、
// 選んだ通信の中身（FlowDetail.tsx）を、グリッドの場所の右側に出す。何を出すか・操作の中身は features/proxy/controller.ts。
// 要求を止めるのを入れていれば（#411）、止めている要求を選んだときに、流す・書き換える・捨てるの並びを中身の上に出す。
// ここは、枠と、キーの受け口を持つ。キーがパネルにある間のキーは、場所のキー（features/proxy/keys.ts。`?` の一覧は placeKeys.ts の proxy）。
import { onCleanup, Show, type JSX } from "solid-js";

import { isHelpKey } from "../../../../features/commands/placeKeys.ts";
import type {
  ProxyPanelState,
  ProxySide,
} from "../../../../features/proxy/controller.ts";
import {
  proxyEditKey,
  proxyPanelKey,
} from "../../../../features/proxy/keys.ts";
import type { ProxyDraft } from "../../../../features/proxy/model.ts";
import { T } from "../../../../i18n/index.ts";
import { Button } from "../../../components/Button.tsx";
import { KeyHints } from "../../../components/KeyHints.tsx";
import { FlowDetail } from "./FlowDetail.tsx";
import { FlowList } from "./FlowList.tsx";
import { PanelBar } from "./PanelBar.tsx";
import { RequestEditor } from "./RequestEditor.tsx";
import styles from "./ProxyPanel.module.css";

/** プロキシのパネル。 */
export function ProxyPanel(props: {
  panel: ProxyPanelState;
  /** タブのマシンの名前（ターミナルのタブのとき、どのマシンのプロキシかを出す） */
  machine: string;
  onSelect: (id: number) => void;
  onStep: (to: "next" | "prev" | "first" | "last") => void;
  onSide: (side?: ProxySide) => void;
  /** キーをタブ（ターミナル・ページ）に戻す */
  onBack: () => void;
  onClose: () => void;
  /** キーの一覧（`?`）を出す */
  onHelp: () => void;
  /** macOS か（書き換える欄の送るキーの字） */
  mac: boolean;
  /** 選んでいる通信の要求を書き換える欄を開く（#410） */
  onEdit: () => void;
  onDraft: (patch: Partial<Omit<ProxyDraft, "from">>) => void;
  onSend: () => void;
  onCancelEdit: () => void;
  /** 要求を行き先に送る前に止めるのを切り替える（#411） */
  onHold: () => void;
  /** 選んでいる、止めている要求を、そのまま流す・捨てる（#411） */
  onRelease: (action: "forward" | "drop") => void;
  /** パネルにキーを向ける関数を受け取る（消えるときは undefined） */
  focusRef: (focus: (() => void) | undefined) => void;
}): JSX.Element {
  let root!: HTMLDivElement;
  // 書き換える欄を出している間は、キーをその欄に向ける
  let editorFocus: (() => void) | undefined;
  props.focusRef(() => (editorFocus ? editorFocus() : root?.focus()));
  onCleanup(() => props.focusRef(undefined));

  const term = () => props.panel.subject.kind === "term";
  const selectedFlow = () =>
    props.panel.scope.flows.find((f) => f.id === props.panel.selected);
  /** 選んでいる通信の中身（読んだものが、ほかの通信のものなら出さない） */
  const detail = () => {
    const d = props.panel.detail;
    return d && d.id === props.panel.selected ? d : undefined;
  };
  /** 止めている要求の数 */
  const heldCount = () =>
    props.panel.scope.flows.filter((f) => f.state === "held").length;
  /** 頭の待ち受け口と、どこの通信か（狭い幅で省いたときは、title で全体を読む） */
  const where = () =>
    term()
      ? T("proxy.where.term", {
          machine: props.machine,
          port: props.panel.scope.port,
        })
      : T("proxy.where.browser", { port: props.panel.scope.port });
  /** 止めている要求を選んでいるか */
  const heldSelected = () => selectedFlow()?.state === "held";

  function onKeyDown(e: KeyboardEvent) {
    // 書き換えている間：欄の中のキーは、その欄が受ける（RequestEditor）。一覧を押してキーがパネルに移っていても、
    // 欄と同じく送る・やめるだけを受ける（足もとの案内のとおりに効くように）
    if (props.panel.edit) {
      const k = proxyEditKey(e, props.mac);
      if (k === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (k === "send") props.onSend();
      else props.onCancelEdit();
      return;
    }
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
    else if (k === "edit") props.onEdit();
    else if (k === "hold") props.onHold();
    else if (k === "forward" || k === "drop") props.onRelease(k);
    else props.onStep(k);
  }

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
      <PanelBar
        class={styles.head}
        lead={
          <>
            <h2 class={styles.title}>{T("proxy.title")}</h2>
            <span class={styles.where} title={where()}>
              {where()}
            </span>
          </>
        }
        actions={
          <>
            <Show when={props.panel.scope.holding}>
              <span class={styles.holding} role="status">
                {T("proxy.hold.count", { count: heldCount() })}
              </span>
            </Show>
            <button
              type="button"
              class={styles.holdButton}
              tabIndex={-1}
              aria-pressed={props.panel.scope.holding}
              title={T("proxy.hold.hint")}
              onClick={() => props.onHold()}
            >
              {props.panel.scope.holding
                ? T("proxy.hold.stop")
                : T("proxy.hold.start")}
            </button>
          </>
        }
      />
      <FlowList
        flows={props.panel.scope.flows}
        selected={props.panel.selected}
        empty={term() ? T("proxy.empty.term") : T("proxy.empty.browser")}
        onSelect={props.onSelect}
      />
      <div class={styles.detail}>
        <Show
          when={props.panel.edit}
          fallback={
            <Show
              when={selectedFlow()}
              fallback={<p class={styles.note}>{T("proxy.detail.none")}</p>}
            >
              {(f) => (
                <>
                  <Show when={f().state === "held"}>
                    <PanelBar
                      class={styles.heldBar}
                      lead={
                        <span class={styles.heldNote}>
                          {T("proxy.held.note")}
                        </span>
                      }
                      actions={
                        <>
                          <Button onClick={() => props.onRelease("drop")}>
                            {T("proxy.held.drop")}
                          </Button>
                          <Button onClick={props.onEdit}>
                            {T("proxy.held.edit")}
                          </Button>
                          <Button
                            variant="primary"
                            onClick={() => props.onRelease("forward")}
                          >
                            {T("proxy.held.forward")}
                          </Button>
                        </>
                      }
                    />
                  </Show>
                  <FlowDetail
                    flow={f()}
                    detail={detail()}
                    // 止めている要求には、まだ応答が無い
                    side={f().state === "held" ? "request" : props.panel.side}
                    onSide={props.onSide}
                  />
                </>
              )}
            </Show>
          }
        >
          {(edit) => (
            <RequestEditor
              edit={edit()}
              mac={props.mac}
              onDraft={props.onDraft}
              onSend={props.onSend}
              onCancel={props.onCancelEdit}
              focusRef={(f) => (editorFocus = f)}
            />
          )}
        </Show>
      </div>
      <div class={styles.foot}>
        <KeyHints
          items={
            props.panel.edit
              ? [
                  {
                    keys: [props.mac ? "Cmd+Enter" : "Ctrl+Enter"],
                    label: props.panel.edit.held
                      ? T("proxy.hint.forward")
                      : T("proxy.hint.send"),
                  },
                  { keys: ["Esc"], label: T("proxy.hint.cancelEdit") },
                ]
              : heldSelected()
                ? [
                    { keys: ["f"], label: T("proxy.hint.forward") },
                    { keys: ["e"], label: T("proxy.hint.editHeld") },
                    { keys: ["d"], label: T("proxy.hint.drop") },
                    { keys: ["j", "k"], label: T("basic.select") },
                    { keys: ["i"], label: T("proxy.hint.holdOff") },
                    { keys: ["?"], label: T("basic.help") },
                    { keys: ["Esc"], label: T("proxy.hint.back") },
                  ]
                : [
                    { keys: ["j", "k"], label: T("basic.select") },
                    { keys: ["Tab"], label: T("proxy.hint.side") },
                    { keys: ["e"], label: T("proxy.hint.edit") },
                    {
                      keys: ["i"],
                      label: props.panel.scope.holding
                        ? T("proxy.hint.holdOff")
                        : T("proxy.hint.hold"),
                    },
                    { keys: ["?"], label: T("basic.help") },
                    { keys: ["Esc"], label: T("proxy.hint.back") },
                    { keys: ["q"], label: T("basic.close") },
                  ]
          }
        />
      </div>
    </div>
  );
}
