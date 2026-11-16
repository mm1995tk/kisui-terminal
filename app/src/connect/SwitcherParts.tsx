// ワークスペースを切り替える窓（WorkspaceSwitcher.tsx）の部品：左の 1 行と、右のタブの一覧。状態は持たない。
import { T } from "../i18n/index.ts";
import { For, Show, type JSX } from "solid-js";

import type { Health, Row } from "../sidebar/model.ts";
import { TabRow } from "../sidebar/Sidebar.tsx";

const healthLabel = (h: Health): string => T(`health.${h}`);

/** 左の 1 行：つかむ所・番号（1〜9。10 個目からは無し）・マシンの色の丸・名前・今の印・タブの数。 */
export function SwitcherRow(props: {
  id: string;
  row: Row;
  /** 上から何番目か（0 から） */
  index: number;
  selected: boolean;
  onGo: () => void;
  /** つかむ所を押した */
  onGrab: (e: PointerEvent) => void;
}): JSX.Element {
  const r = () => props.row;
  return (
    <li
      id={props.id}
      class="card-row switch-row"
      role="option"
      data-gws={r().gws}
      aria-selected={props.selected ? "true" : "false"}
      onClick={() => props.onGo()}
    >
      <span
        class="grip"
        data-grab=""
        aria-hidden="true"
        onPointerDown={(e) => props.onGrab(e)}
        onClick={(e) => e.stopPropagation()}
      />
      <span class="switch-num" aria-hidden="true">
        {props.index < 9 ? props.index + 1 : ""}
      </span>
      <span
        class="switch-dot"
        data-health={r().health}
        style={{ "--machine-color": r().color }}
        role="img"
        aria-label={healthLabel(r().health)}
        title={`${r().machine ? `${r().machine} · ` : ""}${healthLabel(r().health)}`}
      />
      <span class="card-row-name">{r().band.title}</span>
      <Show when={r().band.focused}>
        <span class="switch-current">{T("switcher.current")}</span>
      </Show>
      <span
        class="switch-count"
        title={T("switcher.tabCount", { n: r().tabs.items.length })}
      >
        {r().tabs.items.length}
      </span>
    </li>
  );
}

/** 右の列：選んでいる行のワークスペースの名前と、タブの行（サイドバーの TabRow）。 */
export function SwitcherTabs(props: {
  row: Row;
  onTab: (gws: string, key: string) => void;
}): JSX.Element {
  const r = () => props.row;
  return (
    <div class="switch-tabs" style={{ "--machine-color": r().color }}>
      <div class="switch-tabs-head">{r().band.title}</div>
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
