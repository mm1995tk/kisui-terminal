import { createEffect, For, on, Show, type JSX } from "solid-js";

import { cellOf, gridSize } from "./grid.ts";
import type { TermLink } from "./link.ts";
import { TerminalView } from "./TerminalView.tsx";

/**
 * ターミナルのカード（F1・F4）。ターミナルモードでは、マシンのターミナルを数に応じて自動で並べる
 * （grid.ts）。IDE モードでは、今使っている 1 つだけを見せる（ほかも作り直さずに動かし続ける）。
 * 隠したものを忘れないよう、IDE モードでほかにもあれば、その数を右上に出す。タブは作らない。
 */
export function TerminalGrid(props: {
  /** 並べるターミナル（TermGroup の list） */
  links: readonly TermLink[];
  /** 今使っているターミナル */
  active: TermLink | undefined;
  /** 全部並べるか（ターミナルモード）。false なら active だけを見せる（IDE モード） */
  showAll: boolean;
  /** マシンの色（D4）。並べたときの今の欄の印に使う */
  accent?: string;
  /** 欄を押した・欄にキーを向けた */
  onActivate: (i: number) => void;
}): JSX.Element {
  let el!: HTMLElement;
  // カードの中にキーが向いていたか。終わったシェルの欄が消えるとフォーカスが外れるので、隣の欄に移すため
  let hadFocus = false;

  const shown = () => (props.showAll ? props.links.length : 1);
  const template = () => {
    const { cols, rows } = gridSize(shown());
    return {
      ...(props.accent ? { "--term-accent": props.accent } : {}),
      "grid-template-columns": `repeat(${cols}, minmax(0, 1fr))`,
      "grid-template-rows": `repeat(${rows}, minmax(0, 1fr))`,
    };
  };
  const area = (i: number) => {
    if (!props.showAll) return "1 / 1";
    const c = cellOf(i, props.links.length);
    return `${c.row + 1} / ${c.col + 1} / ${c.row + 2} / ${c.col + 1 + c.span}`;
  };

  createEffect(
    on(
      () => props.links.length,
      (n, prev) => {
        if (prev === undefined || n >= prev || !hadFocus) return;
        if (el.contains(document.activeElement)) return;
        queueMicrotask(() =>
          el
            .querySelector<HTMLElement>(".terminal-cell[data-active] textarea")
            ?.focus({ preventScroll: true }),
        );
      },
    ),
  );

  return (
    <section
      class="terminal"
      aria-label="ターミナル"
      data-split={shown() > 1 ? "" : undefined}
      data-empty={props.links.length === 0 ? "" : undefined}
      style={template()}
      ref={el}
      onFocusIn={() => (hadFocus = true)}
      onFocusOut={(e) => {
        const to = e.relatedTarget as Node | null;
        if (to && !el.contains(to)) hadFocus = false;
      }}
    >
      <For each={props.links}>
        {(link, i) => (
          <TerminalView
            link={link}
            active={link === props.active}
            hidden={!props.showAll && link !== props.active}
            area={area(i())}
            onFocus={() => props.onActivate(i())}
          />
        )}
      </For>
      <Show when={!props.showAll && props.links.length > 1}>
        <p class="terminal-others" role="status">
          ほかに {props.links.length - 1} つ（Ctrl+Shift+` で並べる）
        </p>
      </Show>
    </section>
  );
}
