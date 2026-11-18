// 切り替える窓の右の列の一番下に出す、ターミナルのタブを作る行（n・「＋」）。名前の入力欄と、その右にマシンを 1 行で出す。
// Tab / Shift+Tab で次・前のマシンに替え、↓ かマシンを押すとマシンの一覧を開く。一覧では j / k（↓ / ↑）で選び、Enter で決めて入力欄に戻る。Esc は一覧を閉じるだけ。
// 入力欄で Enter なら onSubmit、Esc か行の外へフォーカスが出たら onCancel。キーは newTabKey.ts。
import { T } from "../../../i18n/index.ts";
import { createSignal, For, Show, type JSX } from "solid-js";

import { newTabInputKey, newTabListKey } from "./newTabKey.ts";

/** タブを作るマシンの候補 1 つ（つながっているマシン） */
export interface MachineChoice {
  target: string;
  label: string;
  color: string;
}

export function SwitcherNewTab(props: {
  machines: readonly MachineChoice[];
  /** 初めに選んでおくマシン（ワークスペースのマシン。候補に無ければ先頭） */
  initial: string;
  placeholder: string;
  /** 断られた理由（あれば入力欄の下に出す。行は開けたまま） */
  error?: string;
  onSubmit: (name: string, machine: string) => void;
  /** byKey は Esc でやめたとき（キーを窓に戻すかを、呼んだ側が決める） */
  onCancel: (byKey: boolean) => void;
}): JSX.Element {
  const start = Math.max(
    0,
    props.machines.findIndex((m) => m.target === props.initial),
  );
  const [index, setIndex] = createSignal(start);
  const [open, setOpen] = createSignal(false);
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
    queueMicrotask(() => {
      list?.focus();
      // 行が一覧の下端にあるとき、開いた一覧が見える所までスクロールする
      list?.scrollIntoView?.({ block: "nearest" });
    });
  }
  function closeList(choose: boolean) {
    if (choose) setIndex(cursor());
    setOpen(false);
    input.focus();
  }

  function onInputKey(e: KeyboardEvent) {
    // 窓のキー（j・n など）に届かせない
    e.stopPropagation();
    const k = newTabInputKey(e);
    if (!k) return;
    e.preventDefault();
    switch (k.kind) {
      case "machine":
        setIndex(wrap(index() + (k.to === "prev" ? -1 : 1)));
        break;
      case "openList":
        openList();
        break;
      case "submit":
        props.onSubmit(input.value, machine()?.target ?? "");
        break;
      case "cancel":
        props.onCancel(true);
        break;
    }
  }
  function onListKey(e: KeyboardEvent) {
    e.stopPropagation();
    const k = newTabListKey(e);
    if (!k) return;
    e.preventDefault();
    if (k.kind === "move")
      setCursor(wrap(cursor() + (k.to === "prev" ? -1 : 1)));
    else closeList(k.kind === "choose");
  }

  return (
    <div
      class="newtab"
      ref={box}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onFocusOut={() => {
        // 入力欄・マシン・一覧の間でフォーカスが動くのは、やめない。行の外へ出たらやめる。
        // 移った先は、フォーカスが落ち着いてから見る（WebKit では focusout の relatedTarget が空のことがあり、頼れない）
        setTimeout(() => {
          if (!box.isConnected || box.contains(document.activeElement)) return;
          // ほかのアプリに切り替えただけ（窓が外れた）では、打ちかけの名前を消さない
          if (document.hasFocus()) props.onCancel(false);
        });
      }}
    >
      <div class="newtab-line">
        <input
          class="inline-input"
          type="text"
          aria-label={T("sidebar.tabNameLabel")}
          aria-invalid={props.error ? "true" : undefined}
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
          // 押しても入力欄からフォーカスを外さない（WebKit はボタンを押してもフォーカスを移さず、行の外へ出たことになる）
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => (open() ? closeList(false) : openList())}
        >
          <span
            class="switch-dot"
            data-health="up"
            style={{ "--machine-color": machine()?.color }}
          />
          <span>{machine()?.label}</span>
          <span class="newtab-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      </div>
      <Show when={props.error}>
        {(e) => (
          <span class="inline-error" role="alert">
            {e()}
          </span>
        )}
      </Show>
      <Show when={open()}>
        <ul
          class="newtab-list"
          role="listbox"
          tabIndex={0}
          aria-label={T("leader.tab.newPick")}
          onKeyDown={onListKey}
          // 一覧の行を押しても、フォーカスは一覧に置いたまま（入力欄に戻すのは closeList）
          onPointerDown={(e) => e.preventDefault()}
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
                  data-health="up"
                  style={{ "--machine-color": m.color }}
                />
                <span>{m.label}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
