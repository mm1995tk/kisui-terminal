// マシンのダイアログ（リーダーの `m`）。すべてのマシンを、つながりの状態とワークスペースの数と一緒に並べ、
// マシンを足す・名前を変える・外す・切る・つなぎ直す（今すぐつなぐ）を、キーで行う。
// 足す・名前を変えるの窓は、これを出したまま、その上に出す（呼んだ側。App.tsx）。キーの決まりは machineList.ts と docs/key-design.md。
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type Accessor,
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

/**
 * 一覧で選んでいる行。選んでいるのは位置ではなくマシンで、外したり足したりして並びが変わっても同じマシンを選び続ける
 * （選んでいるマシンが消えたら、元の位置に寄せる）。
 */
function createRowSelection(
  rows: Accessor<readonly MachineRow[]>,
  initial: string | undefined,
) {
  const [target, setTarget] = createSignal(initial);
  let last = 0;
  const index = createMemo(() => {
    last = keepRow(rows(), target(), last);
    return last;
  });
  return {
    index,
    selected: () => rows()[index()],
    /** 行（位置）を選ぶ */
    pick: (i: number) => setTarget(rows()[i]?.target),
    /** 選ぶ行を動かす */
    move: (to: "next" | "prev" | "first" | "last") =>
      setTarget(rows()[moveRow(index(), to, rows().length)]?.target),
  };
}

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
          <span class="machine-row-mark">（設定ファイル）</span>
        </Show>
      </span>
      <span class="card-row-state">
        <span role="status">{r().status}</span>
        <Show when={r().countdown}>
          {(c) => <span aria-hidden="true">・{c()}</span>}
        </Show>
      </span>
      <span class="card-row-state machine-row-count">
        ワークスペース {r().workspaces}
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
