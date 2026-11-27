import { createMemo, createSignal, For, Show, type JSX } from "solid-js";

import type { Terminals } from "../../../features/terminal/controller.ts";
import {
  selectedPane,
  type PaneCell,
} from "../../../features/terminal/paneMap.ts";
import type { Direction } from "../../../features/terminal/grid.ts";
import { T } from "../../../i18n/index.ts";
import {
  ModalCard,
  CardBody,
  CardText,
  CardTitle,
} from "../../components/Card.tsx";
import { KeyFooter } from "../../components/KeyFooter.tsx";
import { openKeyList } from "../commands/KeyListDialog.tsx";
import {
  splitDirKey,
  terminalWindowFooter,
  terminalWindowKey,
} from "./terminalWindowKey.ts";
import styles from "./TerminalWindow.module.css";

const DIRECTIONS: readonly Direction[] = ["left", "right", "up", "down"];
const cellId = (id: string) => `terminal-window-pane-${id}`;
const pct = (v: number) => `${v * 100}%`;

/** ペインの種類の名前。 */
function kindLabel(kind: PaneCell["kind"]): string {
  switch (kind) {
    case "terminal":
      return T("termWindow.kind.terminal");
    case "video":
      return T("termWindow.kind.video");
    case "image":
      return T("termWindow.kind.image");
    case "pdf":
      return T("termWindow.kind.pdf");
  }
}

/**
 * ターミナルのタブの Dialog（リーダーの `a`。#457）。今のターミナルのタブのペインを、画面と同じ配置の地図として並べ、
 * 1 つを選んで操作する（フォーカスを移す・分ける・隣と入れ替える・閉じる・プライマリ以外を隠す・リサイズモードに入る）。
 * Workspace switcher と同じく、選ぶだけでは実際のフォーカスは動かない。分ける・入れ替える・閉じる・隠すは押したときに行い、Dialog は開いたまま（結果が地図に出る）。
 * タブを作る・閉じる・名前を変える・移すは、ここには置かない（Workspace switcher。リーダーの `t` `n`）。
 * キーは terminalWindowKey.ts、決まりは docs/key-design.md。ペインを 1 回押すと選ぶだけで、ダブルクリックでフォーカスを移す（Enter と同じ）。
 */
export function TerminalWindow(props: {
  terminals: Pick<
    Terminals,
    | "panes"
    | "paneNeighbor"
    | "splitPane"
    | "swapPane"
    | "closePane"
    | "setZoom"
    | "canZoom"
  >;
  /** マシンの色（今フォーカスがあるペインの印に使う） */
  accent?: string;
  /** 選んだペインにフォーカスを移して閉じる（Enter・ダブルクリック） */
  onFocusPane: (id: string) => void;
  /** Dialog を閉じて、リサイズモードに入る（r） */
  onResize: () => void;
  /**
   * 閉じる（Esc・Dialog の外を押した）。acted は、Dialog の中で操作（分ける・入れ替える・閉じる・隠す）をしたか。
   * していれば、開く前にフォーカスがあった所が、閉じた・隠したペインのことがあるので、呼んだ側が今のペインにキーを向け直す。
   */
  onCancel: (acted: boolean) => void;
}): JSX.Element {
  const cells = createMemo(() => props.terminals.panes());
  // 選んでいるペイン。選んでいたペインが無くなったら（閉じた・シェルが終わった）、今フォーカスがあるペインを選び直す
  const [want, setWant] = createSignal<string>();
  const selected = () => selectedPane(cells(), want());
  // 分ける向きを待っているか（s のあと）
  const [splitting, setSplitting] = createSignal(false);
  // できなかった理由（プライマリは閉じられない、など）。次のキーで消す
  const [note, setNote] = createSignal<string>();
  let acted = false;

  /** Key footer に出す、今効く操作（terminalWindowKey.ts の terminalWindowFooter） */
  const footer = createMemo(() => {
    const id = selected();
    const c = cells().find((x) => x.id === id);
    return terminalWindowFooter({
      splitting: splitting(),
      empty: cells().length === 0,
      primary: c?.primary ?? false,
      swappable:
        id !== undefined &&
        DIRECTIONS.some(
          (d) => props.terminals.paneNeighbor(id, d) !== undefined,
        ),
      canZoom: props.terminals.canZoom(),
    });
  });

  function close(id: string) {
    const c = cells().find((x) => x.id === id);
    if (!c) return;
    if (c.primary) {
      setNote(T("termWindow.note.primary"));
      return;
    }
    if (props.terminals.closePane(id)) acted = true;
  }

  function onKeyDown(e: KeyboardEvent) {
    const id = selected();
    // ペインを出せない間は、Esc（ModalCard）だけ
    if (id === undefined) return;
    if (splitting()) {
      const k = splitDirKey(e);
      if (!k) return;
      // Esc は、分けるのをやめるだけ（Dialog は閉じない。ModalCard に渡さない）
      e.preventDefault();
      setSplitting(false);
      setNote(undefined);
      if (k.kind === "dir") {
        acted = true;
        // 足したペインを選ぶ（足せなかった理由は、右下の Notice に出る）
        void props.terminals.splitPane(k.dir, id).then((added) => {
          if (added !== undefined) setWant(added);
        });
      }
      return;
    }
    const k = terminalWindowKey(e);
    if (!k) return;
    e.preventDefault();
    setNote(undefined);
    switch (k.kind) {
      case "select": {
        const to = props.terminals.paneNeighbor(id, k.dir);
        if (to !== undefined) setWant(to);
        break;
      }
      case "focus":
        props.onFocusPane(id);
        break;
      case "split":
        setSplitting(true);
        setNote(T("termWindow.note.split"));
        break;
      case "swap":
        // 場所だけが替わり、選んでいるペイン（id）はそのまま
        setWant(id);
        if (props.terminals.swapPane(id, k.dir)) acted = true;
        break;
      case "close":
        close(id);
        break;
      case "zoom":
        if (props.terminals.canZoom()) {
          acted = true;
          props.terminals.setZoom();
        } else setNote(T("termWindow.note.zoom"));
        break;
      case "resize":
        props.onResize();
        break;
      case "help":
        openKeyList("termWindow");
        break;
    }
  }

  return (
    <ModalCard
      label={T("termWindow.label")}
      width={640}
      closeOnOutside
      onCancel={() => props.onCancel(acted)}
      header={<CardTitle>{T("termWindow.title")}</CardTitle>}
      footer={
        <KeyFooter
          note={
            <Show when={note()}>
              {(n) => (
                <CardText role={splitting() ? "status" : "alert"}>
                  {n()}
                </CardText>
              )}
            </Show>
          }
          rows={footer()}
        />
      }
    >
      <Show
        when={cells().length > 0}
        fallback={
          // ペインを出せない（そのタブのマシンにつながっていない）。フォーカスは Dialog そのものにあり、Esc は ModalCard が受ける
          <CardBody>
            <CardText role="status">{T("termWindow.empty")}</CardText>
          </CardBody>
        }
      >
        <div
          class={styles.map}
          role="listbox"
          aria-label={T("termWindow.label")}
          aria-activedescendant={
            selected() === undefined ? undefined : cellId(selected()!)
          }
          tabIndex={0}
          style={props.accent ? { "--pane-accent": props.accent } : undefined}
          onKeyDown={onKeyDown}
          ref={(el) => queueMicrotask(() => el.focus())}
        >
          <For each={cells()}>
            {(c) => (
              <div
                id={cellId(c.id)}
                class={styles.cell}
                role="option"
                aria-selected={selected() === c.id ? "true" : "false"}
                data-hidden={c.hidden ? "" : undefined}
                style={{
                  left: pct(c.rect.x),
                  top: pct(c.rect.y),
                  width: pct(c.rect.w),
                  height: pct(c.rect.h),
                }}
                onClick={() => {
                  setNote(undefined);
                  setSplitting(false);
                  setWant(c.id);
                }}
                onDblClick={() => props.onFocusPane(c.id)}
              >
                <div class={styles.pane}>
                  <span class={styles.name}>
                    {c.title ?? c.file ?? kindLabel(c.kind)}
                  </span>
                  <Show when={c.title !== undefined || c.file !== undefined}>
                    <span class={styles.kind}>{kindLabel(c.kind)}</span>
                  </Show>
                  <span class={styles.marks}>
                    <Show when={c.primary}>
                      <span class={styles.mark}>{T("termWindow.primary")}</span>
                    </Show>
                    <Show when={c.active}>
                      <span class={styles.mark} data-focused="">
                        {T("termWindow.focused")}
                      </span>
                    </Show>
                    <Show when={c.hidden}>
                      <span class={styles.mark}>{T("termWindow.hidden")}</span>
                    </Show>
                  </span>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </ModalCard>
  );
}
