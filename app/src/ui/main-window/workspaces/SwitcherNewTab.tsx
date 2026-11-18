import { T } from "../../../i18n/index.ts";
import { createSignal, Show, type JSX } from "solid-js";

import { MachineListbox } from "./MachineListbox.tsx";
import { machineIndex, stepMachine } from "./newTabMachine.ts";
import { newTabInputKey } from "./newTabKey.ts";

/** タブを作るマシンの候補 1 つ（つながっているマシン） */
export interface MachineChoice {
  target: string;
  label: string;
  color: string;
}

/**
 * 切り替える窓の右の列の一番下に出す、ターミナルのタブを作る行（n・「＋」）。名前の入力欄と、その右にマシンを 1 行で出す。
 * Tab / Shift+Tab で次・前のマシンに替え、↓ かマシンを押すとマシンの一覧（MachineListbox）を開く。一覧では j / k（↓ / ↑）で選び、Enter で決めて入力欄に戻る。Esc は一覧を閉じるだけ。
 * 入力欄で Enter なら onSubmit、Esc か行の外へフォーカスが出たら onCancel。キーは newTabKey.ts。
 * 選んでいるマシンは target で持つ（行を開いている間に候補が縮んでも、選んでいたマシンのまま。消えたら先頭。newTabMachine.ts）。
 */
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
  const [chosen, setChosen] = createSignal(props.initial);
  const [open, setOpen] = createSignal(false);
  let box!: HTMLDivElement;
  let input!: HTMLInputElement;

  const targets = () => props.machines.map((m) => m.target);
  const machine = (): MachineChoice | undefined =>
    props.machines[machineIndex(targets(), chosen())];

  function closeList(choose?: string) {
    if (choose !== undefined) setChosen(choose);
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
      case "machine": {
        const t = stepMachine(targets(), machine()?.target, k.to);
        if (t !== undefined) setChosen(t);
        break;
      }
      case "openList":
        if (machine()) setOpen(true);
        break;
      case "submit": {
        // マシンが全部切れていたら、作れない（空のマシンでは作らない）
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
          onClick={() => {
            if (open()) closeList();
            else if (machine()) setOpen(true);
          }}
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
        <MachineListbox
          machines={props.machines}
          selected={machine()?.target ?? ""}
          onChoose={(t) => closeList(t)}
          onClose={() => closeList()}
        />
      </Show>
    </div>
  );
}
