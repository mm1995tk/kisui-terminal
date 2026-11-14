// マシンのダイアログ（リーダーの `m`）。すべてのマシンを、つながりの状態とワークスペースの数と一緒に並べ、
// マシンを足す・名前を変える・外す・切る・つなぎ直す（今すぐつなぐ）を、キーで行う。
// 足す・名前を変えるの窓は、これを出したまま、その上に出す（呼んだ側。App.tsx）。キーの決まりは machineList.ts と docs/key-design.md。
import {
  createEffect,
  createSignal,
  For,
  Show,
  untrack,
  type JSX,
} from "solid-js";

import { openKeyList } from "../KeyListDialog.tsx";
import { ModalCard } from "./Card.tsx";
import {
  canDo,
  keepRow,
  machineKey,
  moveRow,
  type MachineAction,
  type MachineRow,
} from "./machineList.ts";

const rowId = (i: number) => `machine-dialog-row-${i}`;

export function MachineDialog(props: {
  rows: MachineRow[];
  /** 開いたときに選んでおくマシン（今のマシン） */
  initial?: string;
  /** 足す（窓は呼んだ側が出す） */
  onAdd: () => void;
  /** 選んだマシンへの操作。できると確かめたあとで呼ぶ */
  onAct: (action: Exclude<MachineAction, "add">, row: MachineRow) => void;
  onCancel: () => void;
}): JSX.Element {
  const [index, setIndex] = createSignal(
    Math.max(
      0,
      props.rows.findIndex((r) => r.target === props.initial),
    ),
  );
  // 行を決めているのは、位置ではなくマシン（外したり足したりして並びが変わっても、同じマシンを選び続ける）
  let target: string | undefined = props.rows[index()]?.target;
  const [note, setNote] = createSignal<string | undefined>();
  let list: HTMLUListElement | undefined;

  createEffect(() => {
    const i = keepRow(props.rows, target, untrack(index));
    setIndex(i);
    target = props.rows[i]?.target;
  });
  createEffect(() => {
    const i = index();
    queueMicrotask(() =>
      list?.children[i]?.scrollIntoView?.({ block: "nearest" }),
    );
  });

  const selected = () => props.rows[index()];

  function onKeyDown(e: KeyboardEvent) {
    const k = machineKey(e);
    if (!k) return;
    e.preventDefault();
    setNote(undefined);
    if (k.kind === "move") {
      const i = moveRow(index(), k.to, props.rows.length);
      setIndex(i);
      target = props.rows[i]?.target;
    } else if (k.kind === "help") {
      openKeyList("machines");
    } else if (k.action === "add") {
      props.onAdd();
    } else {
      const r = selected();
      if (!r) return;
      const why = canDo(r, k.action);
      if (why) setNote(why);
      else props.onAct(k.action, r);
    }
  }

  return (
    <ModalCard label="マシン" width={640} onCancel={props.onCancel}>
      <div class="machine-dialog">
        <div class="card-body">
          <h1 class="card-title">マシン</h1>
        </div>
        <ul
          class="card-rows"
          data-place="machines"
          tabIndex={0}
          role="listbox"
          aria-label="マシンの一覧"
          aria-activedescendant={selected() ? rowId(index()) : undefined}
          onKeyDown={onKeyDown}
          ref={(el) => {
            list = el;
            queueMicrotask(() => el.focus());
          }}
        >
          <For each={props.rows}>
            {(r, i) => (
              <li
                id={rowId(i())}
                class="card-row machine-row"
                role="option"
                aria-selected={index() === i() ? "true" : "false"}
                title={r.title || undefined}
                onClick={() => {
                  setIndex(i());
                  target = r.target;
                }}
              >
                <span
                  class="state-dot"
                  data-health={r.health}
                  aria-hidden="true"
                />
                <span class="card-row-name">
                  {r.label}
                  <Show when={r.fixed}>
                    <span class="machine-row-mark">（設定ファイル）</span>
                  </Show>
                </span>
                <span class="card-row-state">
                  <span role="status">{r.status}</span>
                  <Show when={r.countdown}>
                    {(c) => <span aria-hidden="true">・{c()}</span>}
                  </Show>
                </span>
                <span class="card-row-state machine-row-count">
                  ワークスペース {r.workspaces}
                </span>
              </li>
            )}
          </For>
        </ul>
        <div class="card-body">
          <Show when={note()}>
            {(n) => (
              <p class="card-text" role="alert">
                {n()}
              </p>
            )}
          </Show>
          <p class="machine-keys">
            <kbd>j</kbd> <kbd>k</kbd> 選ぶ・<kbd>a</kbd> 足す・<kbd>n</kbd>{" "}
            名前を変える・<kbd>d</kbd> 外す・<kbd>x</kbd> 切る・<kbd>r</kbd>{" "}
            つなぎ直す・<kbd>?</kbd> キーの一覧・<kbd>Esc</kbd> 閉じる
          </p>
        </div>
      </div>
      <div class="card-actions">
        <button type="button" class="card-button" onClick={props.onCancel}>
          閉じる
        </button>
      </div>
    </ModalCard>
  );
}
