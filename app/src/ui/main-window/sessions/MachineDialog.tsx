// マシンのダイアログ（リーダーの `m`）。すべてのマシンを、つながりの状態とワークスペースの数と一緒に並べ、
// マシンを足す・名前を変える・外す・切る・つなぎ直す（今すぐつなぐ）を、キーで行う。
// 足す・名前を変えるの窓は、これを出したまま、その上に出す（呼んだ側。SessionDialogs.tsx）。キーの決まりは machineList.ts と docs/key-design.md。
import { T } from "../../../i18n/index.ts";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type Accessor,
  type JSX,
} from "solid-js";

import { openKeyList } from "../commands/KeyListDialog.tsx";
import { ModalCard } from "../../components/Card.tsx";
import {
  canDo,
  keepRow,
  machineKey,
  moveRow,
  type MachineAction,
  type MachineRow,
} from "../../../features/sessions/machineList.ts";
import { createRowSelection } from "./rowSelection.ts";

const rowId = (i: number) => `machine-dialog-row-${i}`;

/** 一覧の 1 行（状態の点・名前・設定ファイルの印・状態・ワークスペースの数）。 */
function MachineRowItem(props: {
  row: MachineRow;
  id: string;
  selected: boolean;
  onPick: () => void;
}): JSX.Element {
  const r = () => props.row;
  return (
    <li
      id={props.id}
      class="card-row machine-row"
      role="option"
      aria-selected={props.selected ? "true" : "false"}
      title={r().title || undefined}
      onClick={props.onPick}
    >
      <span class="state-dot" data-health={r().health} aria-hidden="true" />
      <span class="card-row-name">
        {r().label}
        <Show when={r().fixed}>
          <span class="machine-row-mark">{T("machineDialog.fixed")}</span>
        </Show>
      </span>
      <span class="card-row-state">
        <span role="status">{r().status}</span>
        <Show when={r().countdown}>
          {(c) => (
            <span aria-hidden="true">
              {T("machineDialog.countdownSep")}
              {c()}
            </span>
          )}
        </Show>
      </span>
      <span class="card-row-state machine-row-count">
        {T("machineDialog.terminalTabs", { n: r().terminalTabs })}
      </span>
    </li>
  );
}

/**
 * マシンのダイアログ。rows のマシンを並べ、選んだマシンへの操作のキー（足す・名前を変える・外す・切る・つなぎ直す）を受ける。
 * 操作そのものと、足す・名前を変える窓を出すのは呼んだ側（onAdd・onAct）。
 * 閉じるのも呼んだ側で、このダイアログは Esc と「閉じる」で onCancel を呼ぶだけ（出すのをやめるのは呼んだ側）。
 */
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
  const sel = createRowSelection(() => props.rows, props.initial);
  const [note, setNote] = createSignal<string | undefined>();
  let list: HTMLUListElement | undefined;

  createEffect(() => {
    const i = sel.index();
    queueMicrotask(() =>
      list?.children[i]?.scrollIntoView?.({ block: "nearest" }),
    );
  });

  function onKeyDown(e: KeyboardEvent) {
    const k = machineKey(e);
    if (!k) return;
    e.preventDefault();
    setNote(undefined);
    if (k.kind === "move") {
      sel.move(k.to);
    } else if (k.kind === "help") {
      openKeyList("machines");
    } else if (k.action === "add") {
      props.onAdd();
    } else {
      const r = sel.selected();
      if (!r) return;
      const why = canDo(r, k.action);
      if (why) setNote(why);
      else props.onAct(k.action, r);
    }
  }

  return (
    <ModalCard
      label={T("machineDialog.label")}
      width={640}
      onCancel={props.onCancel}
    >
      <div class="machine-dialog">
        <div class="card-body">
          <h1 class="card-title">{T("machineDialog.label")}</h1>
        </div>
        <ul
          class="card-rows"
          data-place="machines"
          tabIndex={0}
          role="listbox"
          aria-label={T("machineDialog.list")}
          aria-activedescendant={
            sel.selected() ? rowId(sel.index()) : undefined
          }
          onKeyDown={onKeyDown}
          ref={(el) => {
            list = el;
            queueMicrotask(() => el.focus());
          }}
        >
          <For each={props.rows}>
            {(r, i) => (
              <MachineRowItem
                row={r}
                id={rowId(i())}
                selected={sel.index() === i()}
                onPick={() => sel.pick(i())}
              />
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
            <kbd>j</kbd> <kbd>k</kbd> {T("machineDialog.keys.select")} ·{" "}
            <kbd>a</kbd> {T("machineDialog.keys.add")} · <kbd>n</kbd>{" "}
            {T("machineDialog.keys.rename")} · <kbd>d</kbd>{" "}
            {T("machineDialog.keys.remove")} · <kbd>x</kbd>{" "}
            {T("machineDialog.keys.disconnect")} · <kbd>r</kbd>{" "}
            {T("machineDialog.keys.reconnect")} · <kbd>?</kbd>{" "}
            {T("machineDialog.keys.keyList")} · <kbd>Esc</kbd>{" "}
            {T("machineDialog.keys.close")}
          </p>
        </div>
      </div>
      <div class="card-actions">
        <button type="button" class="card-button" onClick={props.onCancel}>
          {T("button.close")}
        </button>
      </div>
    </ModalCard>
  );
}
