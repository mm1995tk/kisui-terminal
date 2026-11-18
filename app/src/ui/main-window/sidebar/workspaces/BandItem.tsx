// ワークスペースの帯 1 つ。ヘッダー（BandHeader.tsx）と、中のタブの行（TabRow.tsx）、その下の段（../Panes.tsx。ファイルツリーと CHANGES）。
import { T } from "../../../../i18n/index.ts";
import { createEffect, For, on, Show, type JSX } from "solid-js";

import {
  shownIsBrowser,
  tabToReveal,
  type Row,
  type TabsSnapshot,
} from "../../../../features/workspaces/rows.ts";
import type { Handlers } from "../handlers.ts";
import { Panes } from "../Panes.tsx";
import { BandHeader } from "./BandHeader.tsx";
import { grabTab, TabRow } from "./TabRow.tsx";

/**
 * タブの段の中で、足したタブ・出しているタブが替わったタブが見える所までスクロールする（見せるタブの決め方は model.ts の tabToReveal）。
 */
function revealTabs(
  rows: () => HTMLElement | undefined,
  now: () => TabsSnapshot,
): void {
  createEffect(
    on(now, (cur, prev) => {
      const key = tabToReveal(prev, cur);
      if (!key) return;
      for (const el of rows()?.querySelectorAll<HTMLElement>("li.tab-row") ??
        []) {
        if (el.dataset.key === key) {
          el.scrollIntoView({ block: "nearest" });
          return;
        }
      }
    }),
  );
}

/** 帯 1 つ（ヘッダーとコンテンツ）。 */
export function BandItem(props: Handlers & { row: Row }): JSX.Element {
  const b = () => props.row.band;
  const tabs = () => props.row.tabs;
  // この帯の名前をその場で変えているときだけ、その内容
  const editing = () => {
    const r = props.renaming;
    return r && r.gws === props.row.gws ? r : undefined;
  };
  // shj が動いているときは 3 段に分ける（#284）
  const sections = () => b().focused && b().showTree;
  let tabRows!: HTMLUListElement;
  revealTabs(
    () => tabRows,
    () => ({
      gws: props.row.gws,
      keys: tabs().items.map((t) => t.key),
      shown: tabs().shown,
    }),
  );
  return (
    <li
      class="band-item"
      data-gws={props.row.gws}
      style={{ "--machine-color": props.row.color }}
      data-focused={b().focused ? "" : undefined}
      data-sections={sections() ? "" : undefined}
      data-panes-hidden={sections() && shownIsBrowser(tabs()) ? "" : undefined}
      data-health={props.row.health}
    >
      <BandHeader {...props} editing={editing()} />
      {/* 断られた理由は、帯の下に流れで置く（下のツリーが押し下がる）。重ねると、箱の overflow: clip（#170）で切り取られる */}
      <Show when={editing()?.error}>
        {(e) => (
          <div class="band-rename-error" role="alert">
            {e()}
          </div>
        )}
      </Show>
      <ul
        class="tab-rows"
        ref={tabRows}
        aria-label={T("sidebar.tabsOf", { title: b().title })}
      >
        {/* 行はタブのキーで対応づける。タブの行のデータは、マシンの状態・フォルダ・ページの題などが変わるたびに作り直されるので、
            データのオブジェクトで対応づけると、名前を打っている入力欄ごと作り直されてしまう */}
        <For each={tabs().items.map((t) => t.key)}>
          {(key) => (
            <Show when={tabs().items.find((t) => t.key === key)}>
              {(t) => (
                <TabRow
                  t={t()}
                  shown={tabs().shown === key}
                  current={tabs().shown === key && tabs().focused}
                  onTab={() => props.onTab?.(props.row.gws, key)}
                  onClose={() => props.onTabClose?.(props.row.gws, key)}
                  onRename={
                    props.onTabRename
                      ? () => props.onTabRename?.(props.row.gws, key)
                      : undefined
                  }
                  onGrab={
                    props.onTabMove
                      ? (e) => grabTab(e, props.row.gws, key, props.onTabMove!)
                      : undefined
                  }
                  edit={
                    props.tabRenaming?.gws === props.row.gws &&
                    props.tabRenaming.key === key
                      ? props.tabRenaming
                      : undefined
                  }
                  onRenameSubmit={(name) => props.onTabRenameSubmit?.(name)}
                  onRenameCancel={(byKey) => props.onTabRenameCancel?.(byKey)}
                />
              )}
            </Show>
          )}
        </For>
      </ul>
      <Show when={sections()}>
        <Panes {...props} />
      </Show>
    </li>
  );
}
