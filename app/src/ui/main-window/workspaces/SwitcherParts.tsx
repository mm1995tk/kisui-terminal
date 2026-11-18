// ワークスペースを切り替える窓（WorkspaceSwitcher.tsx）の部品：左の 1 行と、右のタブの一覧。状態は持たない。
import { T } from "../../../i18n/index.ts";
import { For, Show, type JSX } from "solid-js";

import { ICON } from "../sidebar/icons.ts";
import type { Health, Row } from "../../../features/workspaces/rows.ts";
import { InlineInput } from "../../components/InlineInput.tsx";
import { Kbd } from "../../components/KeyHints.tsx";
import { TabRow } from "../sidebar/workspaces/TabRow.tsx";

const healthLabel = (h: Health): string => T(`health.${h}`);

/** 名前を変えている行の入力欄の状態 */
export interface RowEdit {
  /** 今の名前 */
  current: string;
  /** 名前が空のときの、番号の名前 */
  auto: string;
  /** 断られた理由 */
  error?: string;
}

/**
 * 行の右端：鉛筆（名前を変える）と ✕（閉じる）。どの行にもいつも出す。名前を変えている間は出さず、閉じる確認の間は、キーの y と n だけを出す。
 */
function RowActions(props: {
  row: Row;
  editing: boolean;
  confirming: boolean;
  onRename: () => void;
  onClose: () => void;
}): JSX.Element {
  const r = () => props.row;
  return (
    <Show
      when={props.confirming}
      fallback={
        <Show when={!props.editing}>
          <button
            type="button"
            class="switch-btn"
            tabIndex={-1}
            aria-label={T("sidebar.renameBand", { title: r().band.title })}
            title={`${T("sidebar.rename")} (r)`}
            onClick={(e) => {
              e.stopPropagation();
              props.onRename();
            }}
          >
            <span class="nf" aria-hidden="true">
              {ICON.pencil}
            </span>
          </button>
          <button
            type="button"
            class="switch-btn"
            tabIndex={-1}
            aria-label={T("sidebar.closeBand", { title: r().band.title })}
            title={`${T("sidebar.closeWorkspace")} (x)`}
            onClick={(e) => {
              e.stopPropagation();
              props.onClose();
            }}
          >
            <span class="nf" aria-hidden="true">
              {ICON.close}
            </span>
          </button>
        </Show>
      }
    >
      <span
        class="switch-confirm"
        role="alert"
        aria-label={T("switcher.confirmClose", { title: r().band.title })}
      >
        <Kbd>y</Kbd> <Kbd>n</Kbd>
      </span>
    </Show>
  );
}

/**
 * 左の 1 行：つかむ所・マシンの色の丸・名前・鉛筆と ✕。
 * 名前を変えている間は名前の所が入力欄になり、閉じる確認の間は鉛筆と ✕ の所にキーの y と n だけが出る。
 * 押したときにどうするか（選ぶだけか、開くか）は、呼んだ側が決める。
 */
export function SwitcherRow(props: {
  id: string;
  row: Row;
  selected: boolean;
  edit?: RowEdit;
  confirming: boolean;
  /** 押した */
  onPress: () => void;
  /** つかむ所を押した */
  onGrab: (e: PointerEvent) => void;
  onRename: () => void;
  onClose: () => void;
  onRenameSubmit: (name: string) => void;
  onRenameCancel: (byKey: boolean) => void;
}): JSX.Element {
  const r = () => props.row;
  return (
    <li
      id={props.id}
      class="card-row switch-row"
      role="option"
      data-gws={r().gws}
      aria-selected={props.selected ? "true" : "false"}
      onClick={() => props.onPress()}
    >
      <span
        class="grip"
        data-grab=""
        aria-hidden="true"
        onPointerDown={(e) => props.onGrab(e)}
        onClick={(e) => e.stopPropagation()}
      />
      <span
        class="switch-dot"
        data-health={r().health}
        style={{ "--machine-color": r().color }}
        role="img"
        aria-label={healthLabel(r().health)}
        title={`${r().machine ? `${r().machine} · ` : ""}${healthLabel(r().health)}`}
      />
      <Show
        when={props.edit}
        fallback={<span class="card-row-name">{r().band.title}</span>}
      >
        {(edit) => (
          <InlineInput
            value={edit().current}
            label={T("sidebar.nameLabel")}
            placeholder={T("sidebar.namePlaceholder", { auto: edit().auto })}
            error={edit().error}
            onSubmit={props.onRenameSubmit}
            onCancel={props.onRenameCancel}
          />
        )}
      </Show>
      <RowActions
        row={r()}
        editing={!!props.edit}
        confirming={props.confirming}
        onRename={props.onRename}
        onClose={props.onClose}
      />
    </li>
  );
}

/**
 * 右の列：上に選んでいるワークスペースのタブの数、その下にタブの行（サイドバーの TabRow）。行のつかむ所からのドラッグで、タブを移す（tabMoveDrag.ts）。
 * 余白は取らず、列いっぱいに使う（枠と地の色は、列の入れ物 .switcher-right が持つ）。
 */
export function SwitcherTabs(props: {
  row: Row;
  /** キーで選んでいるタブの key（そのワークスペースに無ければ、どれも選ばない） */
  selectedKey?: string;
  /** タブの行を押した（選ぶだけか、出すかは、呼んだ側が決める） */
  onTab: (gws: string, key: string) => void;
  /** タブの行のつかむ所を押した。省くと動かせない */
  onGrab?: (e: PointerEvent, key: string) => void;
}): JSX.Element {
  const r = () => props.row;
  return (
    <div class="switch-tabs" style={{ "--machine-color": r().color }}>
      <div class="switch-tabs-head">
        {T("switcher.tabCount", { n: r().tabs.items.length })}
      </div>
      <ul
        class="tab-rows"
        aria-label={T("sidebar.tabsOf", { title: r().band.title })}
      >
        <For each={r().tabs.items}>
          {(t) => (
            <TabRow
              t={t}
              shown={r().tabs.shown === t.key}
              current={r().tabs.shown === t.key && r().tabs.focused}
              selected={props.selectedKey === t.key}
              onTab={() => props.onTab(r().gws, t.key)}
              onGrab={
                props.onGrab ? (e) => props.onGrab?.(e, t.key) : undefined
              }
            />
          )}
        </For>
      </ul>
      <Show when={r().tabs.items.length === 0}>
        <p class="card-empty">{T("switcher.noTabs")}</p>
      </Show>
    </div>
  );
}
