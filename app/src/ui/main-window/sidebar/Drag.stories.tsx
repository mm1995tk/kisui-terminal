// サイドバーの行のドラッグ（#311）。アプリと同じ CSS（sidebar.css）と drag.ts で出す。
// 「つかんだ行が不透明」「落ちる先の枠」「手を離すとなめらかに落ちる」は、Interactive で実際につかんで確かめる。
// Before は、変える前（opacity: 0.85 で下の行の字が透ける・落ちる先の枠なし）を story の中で書き戻した静止画。
import { createSignal, For, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

import { startDrag } from "./drag.ts";
import "./sidebar.css";

const NAMES = ["zsh  ~/work/app", "shj  README.md", "zsh  ~/work/server"];

/** 変える前のつかんだ行（半透明。下の行と文字が混ざる）。story の中だけで使う */
const BEFORE = `
.drag-before .tab-row[data-dragging] { opacity: 0.85; box-shadow: 0 4px 12px rgb(0 0 0 / 0.3); }
.drag-before ~ .drag-drop-slot { display: none; }
`;

function List(props: { held?: boolean; before?: boolean }): JSX.Element {
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
      <style>{BEFORE}</style>
      <ul
        ref={list}
        class={`tab-rows${props.before ? " drag-before" : ""}`}
        style={{ margin: "0" }}
      >
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

/** 変えた後の、つかんだ行（不透明。下の行の字が透けない） */
export const HeldAfter: Story = { render: () => <List held /> };

/** 変える前の、つかんだ行（半透明で、下の行の字と混ざる） */
export const HeldBefore: Story = { render: () => <List held before /> };
