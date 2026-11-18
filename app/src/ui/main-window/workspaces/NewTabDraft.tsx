// 試作：ワークスペースを切り替える窓で、ターミナルのタブを作る行（WorkspaceColumnsDraft.tsx が使う）。
// 名前の入力欄の右にマシンを出す。Tab / Shift+Tab で次・前のマシンに替え、↓ かマシンを押すとマシンの一覧を開く。
// 一覧では j / k（↑ / ↓）で選び、Enter で決めて入力欄に戻る。Esc は一覧を閉じるだけ。
import { T } from "../../../i18n/index.ts";
import { createSignal, For, Show, type JSX } from "solid-js";

import type { Health } from "../../../features/workspaces/rows.ts";
import { inlineKeyAction } from "../../components/inlineInputKeys.ts";
import { isComposingKey } from "../../../features/commands/ime.ts";

export interface MachineChoice {
  name: string;
  color: string;
  health: Health;
}

export function NewTabDraft(props: {
  machines: readonly MachineChoice[];
  /** 初めに選んでおくマシン（ワークスペースのマシン） */
  initial: string;
  placeholder: string;
  /** マシンの一覧を開いた状態から始める（Storybook で見るため） */
  listOpen?: boolean;
  onSubmit: (name: string, machine: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const start = Math.max(
    0,
    props.machines.findIndex((m) => m.name === props.initial),
  );
  const [index, setIndex] = createSignal(start);
  const [open, setOpen] = createSignal(props.listOpen ?? false);
  // 一覧で選んでいる位置（決めるまでは index を変えない）
  const [cursor, setCursor] = createSignal(start);
  let box!: HTMLDivElement;
  let input!: HTMLInputElement;
  let list: HTMLUListElement | undefined;

  const machine = () => props.machines[index()];
  const n = () => props.machines.length;
  const wrap = (i: number) => (i + n()) % n();

  function openList() {
    setCursor(index());
    setOpen(true);
    queueMicrotask(() => list?.focus());
  }
  function closeList(choose: boolean) {
    if (choose) setIndex(cursor());
    setOpen(false);
    input.focus();
  }

  function onInputKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (isComposingKey(e)) return;
    if (e.key === "Tab") {
      e.preventDefault();
      setIndex(wrap(index() + (e.shiftKey ? -1 : 1)));
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      openList();
      return;
    }
    const a = inlineKeyAction(e);
    if (!a) return;
    e.preventDefault();
    if (a === "submit") props.onSubmit(input.value, machine()?.name ?? "");
    else props.onCancel();
  }
  function onListKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (isComposingKey(e)) return;
    switch (e.key) {
      case "j":
      case "ArrowDown":
        setCursor(wrap(cursor() + 1));
        break;
      case "k":
      case "ArrowUp":
        setCursor(wrap(cursor() - 1));
        break;
      case "Enter":
        closeList(true);
        break;
      case "Escape":
        closeList(false);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  return (
    <div
      class="newtab"
      ref={box}
      onClick={(e) => e.stopPropagation()}
      onFocusOut={() => {
        // 入力欄・マシン・一覧の間でフォーカスが動くのは、やめない。行の外へ出たらやめる。
        // 移った先は、フォーカスが落ち着いてから見る（WebKit では relatedTarget が空のことがあり、頼れない）
        setTimeout(() => {
          if (!box.isConnected || box.contains(document.activeElement)) return;
          if (document.hasFocus()) props.onCancel();
        });
      }}
    >
      <div class="newtab-line">
        <input
          class="inline-input"
          type="text"
          aria-label={T("sidebar.tabNameLabel")}
          placeholder={props.placeholder}
          onKeyDown={onInputKey}
          ref={(el) => {
            input = el;
            setTimeout(() => el.focus());
          }}
        />
        <button
          type="button"
          class="newtab-machine"
          aria-haspopup="listbox"
          aria-expanded={open() ? "true" : "false"}
          title={T("leader.tab.newPick")}
          // 押しても入力欄からフォーカスを外さない（Safari・WebKit はボタンにフォーカスを移さず、行の外へ出たことになる）
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => (open() ? closeList(false) : openList())}
        >
          <span
            class="switch-dot"
            data-health={machine()?.health}
            style={{ "--machine-color": machine()?.color }}
          />
          <span>{machine()?.name}</span>
          <span class="newtab-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      </div>
      <Show when={open()}>
        <ul
          class="newtab-list"
          role="listbox"
          tabIndex={0}
          aria-label={T("leader.tab.newPick")}
          onKeyDown={onListKey}
          ref={(el) => (list = el)}
        >
          <For each={props.machines}>
            {(m, i) => (
              <li
                role="option"
                aria-selected={cursor() === i() ? "true" : "false"}
                data-cursor={cursor() === i() ? "" : undefined}
                onPointerEnter={() => setCursor(i())}
                onClick={() => {
                  setCursor(i());
                  closeList(true);
                }}
              >
                <span
                  class="switch-dot"
                  data-health={m.health}
                  style={{ "--machine-color": m.color }}
                />
                <span>{m.name}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
