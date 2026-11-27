import { T } from "../../../i18n/index.ts";
import { createSignal, Show, type JSX } from "solid-js";

import { MachineListbox } from "./MachineListbox.tsx";
import { createChosenMachine } from "./chosenMachine.ts";
import { newTabInputKey } from "./newTabKey.ts";

/** タブを作るマシンの候補 1 つ（つながっているマシン） */
export interface MachineChoice {
  target: string;
  label: string;
  color: string;
}

/**
 * Workspace switcher の右の列の一番下に出す、ターミナルのタブを作る行（n・「＋」）。名前の入力欄と、その右にマシンを 1 行で出す。
 * Tab / Shift+Tab で次・前のマシンに替え、↓ かマシンを押すとマシンの一覧（MachineListbox）を開く。一覧では j / k（↓ / ↑）で選び、Enter で決めて入力欄に戻る。Esc は一覧を閉じるだけ。
 * 入力欄で Enter なら onSubmit、Esc か行の外へフォーカスが出たら onCancel。キーは newTabKey.ts。
 * 選んでいるマシンの状態は chosenMachine.ts（行を開いている間に候補が縮んでも、選んでいたマシンのまま）。
 * 選んでいたマシンが切れて候補から消えても、ほかのマシンに黙って替えない（#461）。そのマシンを切れた印で出し続け、理由を入力欄の下に出し、
 * Enter では作らない（Tab か一覧で、ほかのマシンを選び直す。つながり直せば、そのまま作れる）。
 */
export function SwitcherNewTab(props: {
  machines: readonly MachineChoice[];
  /** 初めに選んでおくマシン（ワークスペースのマシンか、マシンのダイアログで選んだマシン。開いた時点で候補に無ければ先頭） */
  initial: string;
  placeholder: string;
  /** 断られた理由（あれば入力欄の下に出す。行は開けたまま） */
  error?: string;
  onSubmit: (name: string, machine: string) => void;
  /** byKey は Esc でやめたとき（キーを Dialog に戻すかを、呼んだ側が決める） */
  onCancel: (byKey: boolean) => void;
}): JSX.Element {
  const {
    machine,
    gone,
    shown,
    choose: chooseMachine,
    step,
  } = createChosenMachine(() => props.machines, props.initial);
  const [open, setOpen] = createSignal(false);
  let box!: HTMLDivElement;
  let input!: HTMLInputElement;

  function closeList(choose?: string) {
    if (choose !== undefined) chooseMachine(choose);
    setOpen(false);
    input.focus();
  }

  function onInputKey(e: KeyboardEvent) {
    // Dialog のキー（j・n など）に届かせない
    e.stopPropagation();
    const k = newTabInputKey(e);
    if (!k) return;
    e.preventDefault();
    switch (k.kind) {
      case "machine":
        step(k.to);
        break;
      case "openList":
        if (props.machines.length > 0) setOpen(true);
        break;
      case "submit": {
        // マシンが全部切れていたら・選んでいたマシンが切れたら、作れない（空のマシンでも、ほかのマシンでも作らない）
        const m = machine();
        if (m) props.onSubmit(input.value, m.target);
        break;
      }
      case "cancel":
        props.onCancel(true);
        break;
    }
  }

  return (
    <div
      class="switch-newtab-box"
      ref={box}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onFocusOut={() => {
        // 入力欄・マシン・一覧の間でフォーカスが動くのは、やめない。行の外へ出たらやめる。
        // 移った先は、フォーカスが落ち着いてから見る（WebKit では focusout の relatedTarget が空のことがあり、頼れない）
        setTimeout(() => {
          if (!box.isConnected || box.contains(document.activeElement)) return;
          // ほかのアプリに切り替えただけ（Dialog が外れた）では、打ちかけの名前を消さない
          if (document.hasFocus()) props.onCancel(false);
        });
      }}
    >
      <div class="switch-newtab-line">
        <input
          class="inline-input"
          type="text"
          aria-label={T("sidebar.tabNameLabel")}
          aria-invalid={props.error || gone() ? "true" : undefined}
          placeholder={props.placeholder}
          onKeyDown={onInputKey}
          ref={(el) => {
            input = el;
            setTimeout(() => el.focus());
          }}
        />
        <button
          type="button"
          class="switch-newtab-machine"
          aria-haspopup="listbox"
          aria-expanded={open() ? "true" : "false"}
          title={T("leader.tab.newPick")}
          // 押しても入力欄からフォーカスを外さない（WebKit はボタンを押してもフォーカスを移さず、行の外へ出たことになる）
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            if (open()) closeList();
            else if (props.machines.length > 0) setOpen(true);
          }}
        >
          <span
            class="switch-dot"
            data-health={gone() ? "down" : "up"}
            style={{ "--machine-color": shown()?.color }}
          />
          <span>{shown()?.label}</span>
          <span class="switch-newtab-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      </div>
      <Show
        when={
          gone()
            ? T("switcher.newTab.machineGone", { machine: gone()!.label })
            : props.error
        }
      >
        {(e) => (
          <span class="inline-error" role="alert">
            {e()}
          </span>
        )}
      </Show>
      <Show when={open()}>
        <MachineListbox
          machines={props.machines}
          selected={shown()?.target ?? ""}
          onChoose={(t) => closeList(t)}
          onClose={() => closeList()}
        />
      </Show>
    </div>
  );
}
