// ワークスペースを切り替える窓（WorkspaceSwitcher.tsx）の部品：左の 1 行と、右のタブの一覧。状態は持たない。
import { T } from "../../../i18n/index.ts";
import { For, Show, type JSX } from "solid-js";

import { ICON } from "../sidebar/icons.ts";
import type { Health, Row } from "../../../features/workspaces/rows.ts";
import { renameKeyAction } from "../sidebar/renameInput.ts";
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

/** 名前を変えている行の入力欄（Enter で決め、Esc・フォーカスが外れたらやめる）と、断られた理由。 */
function RowRenameInput(props: {
  edit: RowEdit;
  onSubmit: (name: string) => void;
  onCancel: (byKey: boolean) => void;
}): JSX.Element {
  return (
    <div class="switch-edit">
      <input
        class="switch-rename"
        type="text"
        aria-label={T("sidebar.nameLabel")}
        aria-invalid={props.edit.error ? "true" : undefined}
        placeholder={T("sidebar.namePlaceholder", { auto: props.edit.auto })}
        value={props.edit.current}
        onClick={(e) => e.stopPropagation()}
        onDblClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          const a = renameKeyAction(e);
          if (!a) return;
          e.preventDefault();
          e.stopPropagation();
          if (a === "submit") props.onSubmit(e.currentTarget.value);
          else props.onCancel(true);
        }}
        onBlur={() => {
          // ほかのアプリに切り替えただけ（窓が外れた）では、打ちかけの名前を消さない
          if (document.hasFocus()) props.onCancel(false);
        }}
        ref={(el) =>
          setTimeout(() => {
            el.focus();
            el.select();
          })
        }
      />
      <Show when={props.edit.error}>
        {(e) => (
          <span class="switch-edit-error" role="alert">
            {e()}
          </span>
        )}
      </Show>
    </div>
  );
}

/**
 * 行の右端：選んでいる行の鉛筆（名前を変える）と ✕（閉じる）とタブの数。閉じる確認の間は、タブの数・ボタンの所にキーの y と n だけを出す。
 */
function RowActions(props: {
  row: Row;
  selected: boolean;
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
        <>
          <Show when={props.selected && !props.editing}>
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
          <span
            class="switch-count"
            title={T("switcher.tabCount", { n: r().tabs.items.length })}
          >
            {r().tabs.items.length}
          </span>
        </>
      }
    >
      <span
        class="switch-confirm"
        role="alert"
        aria-label={T("switcher.confirmClose", { title: r().band.title })}
      >
        <kbd>y</kbd> <kbd>n</kbd>
      </span>
    </Show>
  );
}

/**
 * 左の 1 行：つかむ所・マシンの色の丸・名前・今の印・タブの数。
 * 選んでいる行には、名前を変えるボタン（鉛筆）と閉じるボタン（✕）が出る。名前を変えている間は名前の所が入力欄になり、
 * 閉じる確認の間はタブの数・ボタンの所にキーの y と n だけが出る。
 */
export function SwitcherRow(props: {
  id: string;
  row: Row;
  selected: boolean;
  edit?: RowEdit;
  confirming: boolean;
  /** 1 回押した（選ぶだけ） */
  onSelect: () => void;
  /** ダブルクリック（移って閉じる） */
  onGo: () => void;
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
      onClick={() => props.onSelect()}
      onDblClick={(e) => {
        // つかむ所とボタンをすばやく 2 回押しても、移らない（確認や入力欄が出たまま移って閉じないように）
        if (e.target instanceof Element && e.target.closest("button, .grip"))
          return;
        props.onGo();
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
        fallback={<span class="card-row-name">{r().band.title}</span>}
      >
        {(edit) => (
          <RowRenameInput
            edit={edit()}
            onSubmit={props.onRenameSubmit}
            onCancel={props.onRenameCancel}
          />
        )}
      </Show>
      <Show when={r().band.focused && !props.edit}>
        <span class="switch-current">{T("switcher.current")}</span>
      </Show>
      <RowActions
        row={r()}
        selected={props.selected}
        editing={!!props.edit}
        confirming={props.confirming}
        onRename={props.onRename}
        onClose={props.onClose}
      />
    </li>
  );
}

/** 右の列：選んでいる行のワークスペースのタブの行（サイドバーの TabRow）だけ。行のつかむ所からのドラッグで、タブを移す（tabMoveDrag.ts）。 */
export function SwitcherTabs(props: {
  row: Row;
  onTab: (gws: string, key: string) => void;
  /** タブの行のつかむ所を押した。省くと動かせない */
  onGrab?: (e: PointerEvent, key: string) => void;
}): JSX.Element {
  const r = () => props.row;
  return (
    <div class="switch-tabs" style={{ "--machine-color": r().color }}>
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
