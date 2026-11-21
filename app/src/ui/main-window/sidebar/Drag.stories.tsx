// サイドバーの行のドラッグ（#311）。アプリと同じ CSS（sidebar.css）と drag.ts で出す。
// 「つかんだ行が不透明」「落ちる先の枠」「手を離すとなめらかに落ちる」は、Interactive で実際につかんで確かめる。
import { createSignal, For, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

import { startDrag } from "./drag.ts";
import "./sidebar.css";

const NAMES = ["zsh  ~/work/app", "shj  README.md", "zsh  ~/work/server"];

function List(props: { held?: boolean }): JSX.Element {
  const [order, setOrder] = createSignal(NAMES);
  let list!: HTMLUListElement;
  const grab = (e: PointerEvent, name: string) =>
    startDrag(e, {
      scroller: list,
      self: name,
      confine: true,
      rows: () =>
        [...list.querySelectorAll<HTMLElement>("li.tab-row[data-key]")].map(
          (el) => ({
            key: el.dataset.key!,
            el,
            ref: el.querySelector<HTMLElement>(".tab-line") ?? el,
          }),
        ),
      onDrop: (before) => {
        const rest = order().filter((n) => n !== name);
        const i = before === null ? rest.length : rest.indexOf(before);
        setOrder([...rest.slice(0, i), name, ...rest.slice(i)]);
      },
    });
  return (
    <div
      class="sidebar-column"
      style={{ width: "280px", "border-right": "none" }}
    >
      <ul ref={list} class="tab-rows" style={{ margin: "0" }}>
        <For each={order()}>
          {(n, i) => (
            <li
              class="tab-row"
              data-key={n}
              // 静止画：2 行目をつかんで 1 行目に半分重ねる
              data-dragging={props.held && i() === 1 ? "" : undefined}
              style={
                props.held && i() === 1
                  ? { transform: "translateY(-14px)" }
                  : props.held && i() === 0
                    ? { transform: "translateY(0)" }
                    : undefined
              }
            >
              <div class="tab-line">
                <span
                  class="grip"
                  data-grab=""
                  onPointerDown={(e) => grab(e, n)}
                />
                {n}
              </div>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

const meta = {
  title: "main-window/sidebar/Drag",
  parameters: { layout: "centered" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** 実際につかんで確かめる（行の左の点をつかむ）。不透明・影・落ちる先の枠・離したときのなめらかな動き */
export const Interactive: Story = { render: () => <List /> };

/** つかんだ行（不透明。下の行の字が透けない） */
export const HeldAfter: Story = { render: () => <List held /> };

/** 行の色の見比べ（#395）。上から、今のタブ・出しているタブ・ふつうのタブ。今のタブにマウスを乗せても今のタブだと分かること、ほかのタブに乗せると今のタブと違う色になることを、乗せて確かめる */
export const TabStates: Story = {
  render: () => (
    <div
      class="sidebar-column band-item"
      style={{ width: "280px", "border-right": "none" }}
    >
      <ul class="tab-rows" style={{ margin: "0" }}>
        <li class="tab-row" data-current="" data-shown="">
          <div class="tab-line">zsh ~/work/app（今のタブ）</div>
        </li>
        <li class="tab-row" data-shown="">
          <div class="tab-line">shj README.md（出しているタブ）</div>
        </li>
        <li class="tab-row">
          <div class="tab-line">zsh ~/work/server</div>
        </li>
      </ul>
    </div>
  ),
};
