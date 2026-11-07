import { createEffect, For, on, Show, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";

import { IS_MAC } from "../guiKeys.ts";
import type { ExtraPane, PaneLayout } from "../rpc/protocol.ts";
import { layoutRects, reconcileLayout } from "./grid.ts";
import type { TermLink } from "./link.ts";
import type { MediaFetch } from "./media.ts";
import { TerminalView } from "./TerminalView.tsx";
import { BrowserView } from "./BrowserView.tsx";
import { FileView } from "./FileView.tsx";
import { VideoView } from "./VideoView.tsx";

/**
 * ターミナルのカード（F1・F4）。右の欄を全部使い、欄を serve が持つ分割の木（layout。grid.ts）の通りに並べる。
 * プライマリ以外の欄を隠しているときは、プライマリだけを見せる（ほかも作り直さずに動かし続ける）。
 * タブは作らない。
 */
export function TerminalGrid(props: {
  /** 並べるターミナル（TermGroup の list） */
  links: readonly TermLink[];
  /** 欄の配置（分割の木）。無ければ（古い serve）欄の数から自動で決める */
  layout?: PaneLayout;
  /** 今使っているターミナル */
  active: TermLink | undefined;
  /** ターミナルでない欄（動画。#555）。ターミナルの後ろに、同じ升目に並べる */
  extras?: readonly ExtraPane[];
  /** キーを向けているターミナルでない欄。ターミナルを使っているときは undefined */
  activeExtra?: ExtraPane;
  /** ターミナルでない欄の中身を取る関数を作る */
  readExtra?: (pane: ExtraPane) => MediaFetch;
  /** ブラウザの欄を開いたマシン（ssh のホスト名か @local） */
  target?: string;
  onActivateExtra?: (id: string) => void;
  onCloseExtra?: (id: string) => void;
  /** プライマリ以外の欄を隠しているか（隠した欄のターミナルは動かし続ける） */
  zoomed?: boolean;
  /** マシンの色（D4）。並べたときの今の欄の印に使う */
  accent?: string;
  /** 欄を押した・欄にキーを向けた */
  onActivate: (i: number) => void;
  /** 今使っている欄にキーを向ける関数を受け取る */
  focusRef?: (focusActive: () => void) => void;
}): JSX.Element {
  let el!: HTMLElement;
  // カードの中にキーが向いていたか。終わったシェルの欄が消えるとフォーカスが外れるので、隣の欄に移すため
  let hadFocus = false;
  // 欄ごとの「キーを向ける」関数（coneko-term の focus()）
  const focusers = new Map<TermLink, () => void>();
  const extraFocusers = new Map<string, () => void>();
  const extras = () => props.extras ?? [];
  const total = () => props.links.length + extras().length;
  const focusActive = () => {
    const x = props.activeExtra;
    if (x) {
      extraFocusers.get(x.id)?.();
      return;
    }
    const a = props.active;
    if (a) focusers.get(a)?.();
  };
  props.focusRef?.(focusActive);

  const shown = () => (props.zoomed ? 1 : total());
  const visible = (i: number) => !props.zoomed || i === 0;
  const extraVisible = (_x: ExtraPane) => !props.zoomed;
  const tree = () =>
    reconcileLayout(props.layout, [
      ...props.links.map((l) => l.id),
      ...extras().map((x) => x.id),
    ]);
  const rects = () => layoutRects(tree());
  const template = () =>
    props.accent ? { "--term-accent": props.accent } : {};
  // 欄は親の中に絶対位置で置く（木が変わっても、欄の要素は作り直さない）。欄の間は 1px の線を見せる
  const place = (id: string): Record<string, string> => {
    if (props.zoomed || rects().size <= 1) return { inset: "0" };
    const r = rects().get(id);
    if (!r) return { display: "none" };
    const pct = (v: number) => `${v * 100}%`;
    return {
      left: `calc(${pct(r.x)} + 0.5px)`,
      top: `calc(${pct(r.y)} + 0.5px)`,
      width: `calc(${pct(r.w)} - 1px)`,
      height: `calc(${pct(r.h)} - 1px)`,
    };
  };

  createEffect(
    on(total, (n, prev) => {
      if (prev === undefined || n >= prev || !hadFocus) return;
      if (el.contains(document.activeElement)) return;
      queueMicrotask(focusActive);
    }),
  );

  return (
    <section
      class="terminal"
      aria-label="ターミナル"
      data-split={shown() > 1 ? "" : undefined}
      data-empty={total() === 0 ? "" : undefined}
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
            hidden={!visible(i())}
            place={place(link.id)}
            onFocus={() => props.onActivate(i())}
            focusRef={(f) =>
              f ? focusers.set(link, f) : focusers.delete(link)
            }
          />
        )}
      </For>
      <For each={extras()}>
        {(x) => (
          <Show
            when={x.kind === "browser"}
            fallback={
              <Dynamic
                component={x.kind === "video" ? VideoView : FileView}
                pane={x}
                read={props.readExtra!(x)}
                active={x.id === props.activeExtra?.id}
                hidden={!extraVisible(x)}
                place={place(x.id)}
                onFocus={() => props.onActivateExtra?.(x.id)}
                onClose={() => props.onCloseExtra?.(x.id)}
                focusRef={(f) =>
                  f ? extraFocusers.set(x.id, f) : extraFocusers.delete(x.id)
                }
              />
            }
          >
            <BrowserView
              pane={x}
              target={props.target ?? ""}
              active={x.id === props.activeExtra?.id}
              hidden={!extraVisible(x)}
              place={place(x.id)}
              onFocus={() => props.onActivateExtra?.(x.id)}
              onClose={() => props.onCloseExtra?.(x.id)}
              focusRef={(f) =>
                f ? extraFocusers.set(x.id, f) : extraFocusers.delete(x.id)
              }
            />
          </Show>
        )}
      </For>
      <Show when={props.zoomed && total() > 1}>
        <p class="terminal-others" role="status">
          ほかに {total() - 1} つを隠している（
          {IS_MAC ? "Cmd+Shift+Enter" : "Ctrl+Shift+M"} で戻す）
        </p>
      </Show>
    </section>
  );
}
