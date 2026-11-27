// Workspace switcher の「タブを作る」行（SwitcherNewTab.tsx）の、マシンの一覧。
import { T } from "../../../i18n/index.ts";
import { createSignal, For, untrack, type JSX } from "solid-js";

import type { MachineChoice } from "./SwitcherNewTab.tsx";
import { firstMachine, machineIndex, stepMachine } from "./newTabMachine.ts";
import { newTabListKey } from "./newTabKey.ts";

/**
 * マシンの一覧（行の下に開く）。開くと自分にフォーカスを取り、j k（↓ ↑）で選び、Enter か行を押して onChoose、Esc で onClose を呼ぶ。
 * 選んでいる位置は target で持つ（決めるまでは呼んだ側の選びを変えない）。キーは Dialog のキーに伝えない。
 */
export function MachineListbox(props: {
  machines: readonly MachineChoice[];
  /** 開いたときに選んでおくマシンの target */
  selected: string;
  onChoose: (target: string) => void;
  onClose: () => void;
}): JSX.Element {
  const targets = () => props.machines.map((m) => m.target);
  // 選んでいたマシンが切れて候補に無ければ、先頭から
  const [cursor, setCursor] = createSignal(
    firstMachine(untrack(targets), props.selected),
  );
  const at = () => machineIndex(targets(), cursor());

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    const k = newTabListKey(e);
    if (!k) return;
    e.preventDefault();
    if (k.kind === "move") {
      const t = stepMachine(targets(), cursor(), k.to);
      if (t !== undefined) setCursor(t);
    } else if (k.kind === "close") props.onClose();
    else {
      const m = props.machines[at()];
      if (m) props.onChoose(m.target);
    }
  }

  return (
    <ul
      class="switch-newtab-list"
      role="listbox"
      tabIndex={0}
      aria-label={T("leader.tab.newPick")}
      onKeyDown={onKey}
      // 一覧の行を押しても、フォーカスは一覧に置いたまま（入力欄に戻すのは呼んだ側）
      onPointerDown={(e) => e.preventDefault()}
      ref={(el) =>
        queueMicrotask(() => {
          el.focus();
          // 行が一覧の下端にあるとき、開いた一覧が見える所までスクロールする
          el.scrollIntoView?.({ block: "nearest" });
        })
      }
    >
      <For each={props.machines}>
        {(m) => (
          <li
            role="option"
            aria-selected={cursor() === m.target ? "true" : "false"}
            data-cursor={cursor() === m.target ? "" : undefined}
            onPointerEnter={() => setCursor(m.target)}
            onClick={() => props.onChoose(m.target)}
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
  );
}
