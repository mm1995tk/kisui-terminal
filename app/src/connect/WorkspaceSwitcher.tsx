import { T } from "../i18n/index.ts";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type JSX,
} from "solid-js";

import { startDrag } from "../sidebar/drag.ts";
import type { Health, Row } from "../sidebar/model.ts";
import { TabRow } from "../sidebar/Sidebar.tsx";
import { ModalCard } from "./Card.tsx";
import { moveRow } from "./machineList.ts";
import { switcherKey } from "./switcherKey.ts";
import "./switcher.css";

const rowId = (i: number) => `switcher-row-${i}`;

/**
 * ワークスペースを切り替える窓（リーダーの `w w`。#282）。左に全ワークスペース（サイドバーと同じ並び）、右に左で選んでいる行のタブの一覧を出す。
 * キーは switcherKey.ts、決まりは docs/key-design.md。左の行を押すとそのワークスペースへ移り、行の左端のつかむ所からのドラッグで並べ替える
 * （サイドバーの帯と同じ drag.ts。並びを覚えるのは呼んだ側）。右のタブの行を押すと、そのワークスペースのそのタブへ移る。
 * 移ったあとに窓を閉じるのは、呼んだ側（出すのをやめる）。
 */
export function WorkspaceSwitcher(props: {
  /** サイドバーの行（GUI のワークスペース 1 つが 1 行）。並びは、ユーザーが並べた順 */
  rows: readonly Row[];
  /** 左の行を選んで移った（Enter・押す・1〜9） */
  onGo: (row: Row) => void;
  /** 直前のワークスペースへ移る（Tab） */
  onLast: () => void;
  /** 右のタブの行を押した */
  onTab: (gws: string, key: string) => void;
  /** 1 つ下・上へ並べ替える（J K） */
  onReorder: (gws: string, dir: "up" | "down") => void;
  /** つかんで落とした（before は、その行のすぐ前の GUI のワークスペースの id。一番後ろなら null） */
  onDrop: (gws: string, before: string | null) => void;
  /** 「ワークスペースを作る」 */
  onNew: () => void;
  onCancel: () => void;
}): JSX.Element {
  // 選んでいるのは位置ではなくワークスペース。並べ替えても、同じワークスペースを選び続ける
  const [sel, setSel] = createSignal<string | undefined>(
    (props.rows.find((r) => r.band.focused) ?? props.rows[0])?.gws,
  );
  let last = 0;
  const index = createMemo(() => {
    const i = props.rows.findIndex((r) => r.gws === sel());
    last =
      i >= 0
        ? i
        : Math.min(Math.max(0, last), Math.max(0, props.rows.length - 1));
    return last;
  });
  const selected = (): Row | undefined => props.rows[index()];
  let list!: HTMLUListElement;

  // 選ぶ行が見える所へ（9 個を超えると、一覧がスクロールする）
  createEffect(() => {
    const i = index();
    document.getElementById(rowId(i))?.scrollIntoView?.({ block: "nearest" });
  });

  function onKeyDown(e: KeyboardEvent) {
    const k = switcherKey(e);
    if (!k) return;
    e.preventDefault();
    switch (k.kind) {
      case "move":
        setSel(props.rows[moveRow(index(), k.to, props.rows.length)]?.gws);
        break;
      case "go": {
        const r = selected();
        if (r) props.onGo(r);
        break;
      }
      case "nth": {
        const r = props.rows[k.index];
        if (r) props.onGo(r);
        break;
      }
      case "last":
        props.onLast();
        break;
      case "reorder": {
        const r = selected();
        if (r) props.onReorder(r.gws, k.dir);
        break;
      }
    }
  }

  /** つかむ所を押した。左の一覧の行を、真ん中の高さで比べて、落とした先の行の前へ動かす。 */
  function grab(e: PointerEvent, gws: string) {
    startDrag(e, {
      scroller: list,
      self: gws,
      rows: () =>
        [...list.querySelectorAll<HTMLElement>("li.switch-row[data-gws]")].map(
          (el) => ({ key: el.dataset.gws!, el, ref: el }),
        ),
      onDrop: (before) => props.onDrop(gws, before),
    });
  }

  return (
    <ModalCard
      label={T("switcher.label")}
      width={880}
      onCancel={props.onCancel}
    >
      <div class="machine-dialog switcher">
        <div class="card-body">
          <h1 class="card-title">{T("switcher.title")}</h1>
        </div>
        <div class="switcher-cols">
          <div class="switcher-left">
            <ul
              class="card-rows switch-rows"
              tabIndex={0}
              role="listbox"
              aria-label={T("switcher.title")}
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
                    class="card-row switch-row"
                    role="option"
                    data-gws={r.gws}
                    aria-selected={index() === i() ? "true" : "false"}
                    onClick={() => props.onGo(r)}
                  >
                    <span
                      class="grip"
                      data-grab=""
                      aria-hidden="true"
                      onPointerDown={(e) => grab(e, r.gws)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span class="switch-num" aria-hidden="true">
                      {i() < 9 ? i() + 1 : ""}
                    </span>
                    <span
                      class="switch-dot"
                      data-health={r.health}
                      style={{ "--machine-color": r.color }}
                      role="img"
                      aria-label={healthLabel(r.health)}
                      title={`${r.machine ? `${r.machine} · ` : ""}${healthLabel(r.health)}`}
                    />
                    <span class="card-row-name">{r.band.title}</span>
                    <Show when={r.band.focused}>
                      <span class="switch-current">
                        {T("switcher.current")}
                      </span>
                    </Show>
                    <span
                      class="switch-count"
                      title={T("switcher.tabCount", { n: r.tabs.items.length })}
                    >
                      {r.tabs.items.length}
                    </span>
                  </li>
                )}
              </For>
              <Show when={props.rows.length === 0}>
                <li class="card-empty">{T("switcher.empty")}</li>
              </Show>
            </ul>
            <button
              type="button"
              class="switch-new"
              tabIndex={-1}
              onClick={() => props.onNew()}
            >
              + {T("switcher.new")}
            </button>
          </div>
          <div class="switcher-right">
            <Show when={selected()}>
              {(r) => (
                <div
                  class="switch-tabs"
                  style={{ "--machine-color": r().color }}
                >
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
              )}
            </Show>
          </div>
        </div>
        <div class="card-body">
          <p class="machine-keys">
            <kbd>j</kbd> <kbd>k</kbd> {T("machineDialog.keys.select")} ·{" "}
            <kbd>Enter</kbd> {T("switcher.keys.go")} · <kbd>1</kbd>-<kbd>9</kbd>{" "}
            {T("switcher.keys.nth")} · <kbd>Tab</kbd> {T("switcher.keys.last")}{" "}
            · <kbd>J</kbd> <kbd>K</kbd> {T("switcher.keys.reorder")} ·{" "}
            <kbd>Esc</kbd> {T("mascot.keys.cancel")}
          </p>
        </div>
      </div>
      <div class="card-actions">
        <button type="button" class="card-button" onClick={props.onCancel}>
          {T("button.cancelAlt")}
        </button>
      </div>
    </ModalCard>
  );
}

const healthLabel = (h: Health): string => T(`health.${h}`);
