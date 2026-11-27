// Workspace switcher（WorkspaceSwitcher.tsx）の部品：左の 1 行と、右のタブの一覧。状態は持たない。
import { T } from "../../../i18n/index.ts";
import { For, Show, type JSX } from "solid-js";

import { ICON } from "../sidebar/icons.ts";
import type {
  Health,
  Row,
  TabItem,
} from "../../../features/workspaces/rows.ts";
import { InlineInput } from "../../components/InlineInput.tsx";
import { Kbd } from "../../components/KeyHints.tsx";
import { TabRow } from "../sidebar/workspaces/TabRow.tsx";
import { type MachineChoice, SwitcherNewTab } from "./SwitcherNewTab.tsx";

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
  /** タブをつかんでいる間、つかんだときのワークスペースの行か（点線で囲む） */
  heldFrom?: boolean;
  /** タブをつかんでいる間、移す先に選んでいる行か（「ここの一番後ろに入る →」を出す） */
  dropHere?: boolean;
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
  // つかむ所を押して、同じ行の別の所で離すと、click は両方を含むこの li で起きる（つかむ所の stopPropagation は届かない）。
  // 並べ替えのつもりが「選んでいる行をもう 1 回押した」にならないよう、つかむ所から始まった押し方の click は捨てる
  let fromGrip = false;
  return (
    <li
      id={props.id}
      class="card-row switch-row"
      role="option"
      data-gws={r().gws}
      data-held-from={props.heldFrom ? "" : undefined}
      aria-selected={props.selected ? "true" : "false"}
      onPointerDown={(e) => {
        fromGrip = e.target instanceof Element && !!e.target.closest(".grip");
      }}
      onClick={() => {
        if (fromGrip) {
          fromGrip = false;
          return;
        }
        props.onPress();
      }}
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
        fallback={
          <span class="card-row-name">
            {r().band.title}
            <Show when={props.dropHere}>
              <span class="switch-drop-here">{T("switcher.dropHere")}</span>
            </Show>
          </span>
        }
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
 * 上の右端に、タブを作る「＋」を置く。押すと、作るタブの種類を選ぶ間になる（種類は Dialog の Key footer のボタン）。ターミナルに決めると、タブの行の一番下に、タブを作る行（newTab）が出る。
 */
export function SwitcherTabs(props: {
  row: Row;
  /** 出すタブ（省くと row のタブ。キーでつかんでいる間は、つかんだタブを入る位置に入れたもの） */
  items?: readonly TabItem[];
  /** キーでつかんで移しているタブ（つかんでいる間だけ。見出しはタブの数の代わりに「〈名前〉を移しています」になり、ほかのタブは薄くなる） */
  holding?: Pick<TabItem, "key" | "title">;
  /** キーで選んでいるタブの key（そのワークスペースに無ければ、どれも選ばない） */
  selectedKey?: string;
  /** タブの行の id を、key から作る（Dialog の aria-activedescendant が指す） */
  rowId?: (key: string) => string;
  /** タブの行を押した（選ぶだけか、出すかは、呼んだ側が決める） */
  onTab: (gws: string, key: string) => void;
  /** タブの行のつかむ所を押した。省くと動かせない */
  onGrab?: (e: PointerEvent, key: string) => void;
  /** タブの行の鉛筆（r と同じ）・✕（x と同じ）を押した */
  onRename?: (gws: string, key: string) => void;
  onClose?: (gws: string, key: string) => void;
  /** 名前を変えているタブ（その行の 1 行目が入力欄になる）と、入力欄の決定・やめる */
  editKey?: string;
  edit?: RowEdit;
  onRenameSubmit?: (name: string) => void;
  onRenameCancel?: (byKey: boolean) => void;
  /** 「＋」（n と同じ）を押した */
  onNewTab?: () => void;
  /** タブを作る行（SwitcherNewTab）。出している間だけ渡す */
  newTab?: {
    machines: readonly MachineChoice[];
    initial: string;
    error?: string;
    onSubmit: (name: string, machine: string) => void;
    onCancel: (byKey: boolean) => void;
  };
}): JSX.Element {
  const r = () => props.row;
  return (
    <div
      class="switch-tabs"
      data-holding={props.holding ? "" : undefined}
      style={{ "--machine-color": r().color }}
    >
      <div class="switch-tabs-head">
        <Show
          when={props.holding}
          fallback={
            <span>{T("switcher.tabCount", { n: r().tabs.items.length })}</span>
          }
        >
          {(h) => (
            <span class="switch-holding">
              {T("switcher.holding", { title: h().title })}
            </span>
          )}
        </Show>
        <span class="switch-tabs-btns">
          <button
            type="button"
            class="switch-btn"
            tabIndex={-1}
            aria-label={T("switcher.newTab")}
            title={`${T("switcher.newTab")} (n)`}
            onClick={() => props.onNewTab?.()}
          >
            <span class="nf" aria-hidden="true">
              {ICON.plus}
            </span>
          </button>
        </span>
      </div>
      <ul
        class="tab-rows"
        aria-label={T("sidebar.tabsOf", { title: r().band.title })}
      >
        <For each={props.items ?? r().tabs.items}>
          {(t) => (
            <TabRow
              t={t}
              shown={r().tabs.shown === t.key}
              current={r().tabs.shown === t.key && r().tabs.focused}
              selected={props.selectedKey === t.key}
              held={props.holding?.key === t.key}
              id={props.rowId?.(t.key)}
              onTab={() => props.onTab(r().gws, t.key)}
              onRename={() => props.onRename?.(r().gws, t.key)}
              onClose={() => props.onClose?.(r().gws, t.key)}
              edit={props.editKey === t.key ? props.edit : undefined}
              onRenameSubmit={props.onRenameSubmit}
              onRenameCancel={props.onRenameCancel}
              onGrab={
                props.onGrab ? (e) => props.onGrab?.(e, t.key) : undefined
              }
            />
          )}
        </For>
        <Show when={props.newTab}>
          {(c) => (
            <li class="tab-row switch-newtab">
              <div class="tab-line">
                <SwitcherNewTab
                  machines={c().machines}
                  initial={c().initial}
                  placeholder={T("switcher.newTabPlaceholder")}
                  error={c().error}
                  onSubmit={c().onSubmit}
                  onCancel={c().onCancel}
                />
              </div>
            </li>
          )}
        </Show>
      </ul>
      <Show when={r().tabs.items.length === 0 && !props.newTab}>
        <p class="card-empty">{T("switcher.noTabs")}</p>
      </Show>
    </div>
  );
}
