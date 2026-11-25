// マシンのダイアログ（リーダーの `m`）。すべてのマシンを、つながりの状態とワークスペースの数と一緒に並べ、
// マシンを足す・名前を変える・外す・切る・つなぎ直す（今すぐつなぐ）を、キーで行う。
// Enter は、選んだマシンを設定したターミナルのタブ作成を、ワークスペースの窓で始める（#461。窓を開くのは呼んだ側）。
// 足す窓は、これを出したまま、その上に出す（呼んだ側。SessionDialogs.tsx）。名前は、選んだ行をその場で入力欄にして変える。
// キーの決まりは machineList.ts と docs/key-design.md。
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
import { KeyFooter } from "../../components/KeyFooter.tsx";
import { ModalCard, CardTitle, CardText } from "../../components/Card.tsx";
import { basicHints } from "../../../features/commands/placeKeys.ts";
import {
  canDo,
  keepRow,
  machineKey,
  moveRow,
  type MachineAction,
  type MachineRow,
} from "../../../features/sessions/machineList.ts";
import { InlineInput } from "../../components/InlineInput.tsx";
import { createRowSelection } from "./rowSelection.ts";

const rowId = (i: number) => `machine-dialog-row-${i}`;

/** 名前を変えている行と、断られた理由 */
export interface MachineRename {
  target: string;
  error?: string;
}

/** 一覧の 1 行（状態の点・名前・設定ファイルの印・状態・ワークスペースの数）。名前を変えている間は、名前の所が入力欄になる。 */
function MachineRowItem(props: {
  row: MachineRow;
  id: string;
  selected: boolean;
  onPick: () => void;
  /** 名前を変えている行なら、断られた理由（無ければ ""）。変えていなければ undefined */
  editError?: string;
  onRenameSubmit: (name: string) => void;
  onRenameCancel: (byKey: boolean) => void;
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
      <Show
        when={props.editError === undefined}
        fallback={
          <InlineInput
            value={r().label}
            label={T("rename.name")}
            placeholder={T("rename.placeholder", { fallback: r().target })}
            error={props.editError || undefined}
            onSubmit={props.onRenameSubmit}
            onCancel={props.onRenameCancel}
          />
        }
      >
        <span class="card-row-name">
          {r().label}
          <Show when={r().fixed}>
            <span class="machine-row-mark">{T("machineDialog.fixed")}</span>
          </Show>
        </span>
      </Show>
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
 * 操作そのものと、足す窓を出すのは呼んだ側（onAdd・onAct）。名前を変える（onAct の "rename"）と、呼んだ側が renaming を渡し、その行が入力欄になる。
 * 閉じるのも呼んだ側で、このダイアログは Esc と「閉じる」で onCancel を呼ぶだけ（出すのをやめるのは呼んだ側）。
 */
export function MachineDialog(props: {
  rows: MachineRow[];
  /** 開いたときに選んでおくマシン（今のマシン） */
  initial?: string;
  /** 足す（窓は呼んだ側が出す） */
  onAdd: () => void;
  /** 今のワークスペースがあるか（無ければ Enter のタブ作成は始めず、理由を出す） */
  hasWorkspace: boolean;
  /** 選んだマシンへの操作。できると確かめたあとで呼ぶ */
  onAct: (action: Exclude<MachineAction, "add">, row: MachineRow) => void;
  /** 名前を変えている行（無ければ null か undefined） */
  renaming?: MachineRename | null;
  /** 入力欄で Enter を押した（断るなら、呼んだ側が renaming の error を渡す） */
  onRenameSubmit?: (target: string, name: string) => void;
  /** 入力欄で Esc を押した・フォーカスが外れた */
  onRenameCancel?: () => void;
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

  // 名前を決めて入力欄が消えたら、キーを一覧に戻す
  let wasRenaming = false;
  createEffect(() => {
    const now = !!props.renaming;
    if (wasRenaming && !now) queueMicrotask(() => list?.focus());
    wasRenaming = now;
  });

  function onKeyDown(e: KeyboardEvent) {
    // 名前の入力欄の中のキーは、入力欄が受ける
    if (e.target instanceof HTMLInputElement) return;
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
      const why = canDo(r, k.action, props.hasWorkspace);
      if (why) {
        setNote(why);
        return;
      }
      // ワークスペースの窓を開く Enter を、ほかのキーの受け手に届かせない（開いた窓の作成の確定まで伝わらないように）
      if (k.action === "newTab") e.stopPropagation();
      props.onAct(k.action, r);
    }
  }

  return (
    <ModalCard
      label={T("machineDialog.label")}
      width={640}
      onCancel={props.onCancel}
      footer={
        // 足す・名前を変える・外す・切る・つなぎ直す（a n d x r）は、`?` の一覧に出す。Enter（タブを作る）は下の段にも出す
        <KeyFooter
          note={
            <Show when={note()}>
              {(n) => <CardText role="alert">{n()}</CardText>}
            </Show>
          }
          items={basicHints({
            decide: T("machineDialog.keys.newTab"),
            end: "close",
          })}
        />
      }
      header={<CardTitle>{T("machineDialog.label")}</CardTitle>}
    >
      <div class="machine-dialog">
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
          {/* 行は ssh の行き先で対応づける。行のデータは状態の文が変わるたびに作り直されるので、
              データのオブジェクトで対応づけると、名前を打っている入力欄ごと作り直されてしまう */}
          <For each={props.rows.map((r) => r.target)}>
            {(target, i) => (
              <Show when={props.rows.find((r) => r.target === target)}>
                {(r) => (
                  <MachineRowItem
                    row={r()}
                    id={rowId(i())}
                    selected={sel.index() === i()}
                    onPick={() => sel.pick(i())}
                    editError={
                      props.renaming?.target === target
                        ? (props.renaming.error ?? "")
                        : undefined
                    }
                    onRenameSubmit={(name) =>
                      props.onRenameSubmit?.(target, name)
                    }
                    onRenameCancel={() => props.onRenameCancel?.()}
                  />
                )}
              </Show>
            )}
          </For>
        </ul>
      </div>
    </ModalCard>
  );
}
