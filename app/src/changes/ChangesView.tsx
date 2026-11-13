// 差分モードの CHANGES の一覧（ファイルエクスプローラの下）を、TUI の CHANGES と同じフォルダの木で描く。
// 行を押す（Enter・l・o でも）と、そのファイルの差分を shj に出させる。フォルダの行は押すと開け閉めする。
// shj が今差分を出しているファイルの行は強調する。見た目は changes.css。
// 行にフォーカスがあるときは TUI と同じキーで動かせる（#45。割り当ては keys.ts、操作は actions.ts、1 行の描画は ChangeTreeRow.tsx）。
import { createMemo, createSignal, Index, Show, type JSX } from "solid-js";

import { runChangesAction, type ChangesHandlers } from "./actions.ts";
import { ChangeTreeRow } from "./ChangeTreeRow.tsx";
import { changesKey } from "./keys.ts";
import {
  changeTree,
  changesBaseLabel,
  type ChangeRow,
  type ChangesBase,
} from "./model.ts";
import "./changes.css";

export type { ChangesHandlers };

/**
 * CHANGES の一覧。label は一覧の読み上げの名前。
 * rows の順番は shj が見せる順。閉じたフォルダは、この一覧が覚えている（描き直しても残る）。
 */
export function ChangesView(
  props: ChangesHandlers & {
    rows: ChangeRow[];
    /** 比べている相手（HEAD / PR）。見出しに出す */
    base: ChangesBase;
    label: string;
    /** ファイルツリーとの境目（この一覧の上の縁）をつかんだ。height は今の一覧の高さ。無ければ境目のつまみを出さない */
    onResizeStart?: (e: PointerEvent, height: number) => void;
    /** 境目をダブルクリックした */
    onResizeReset?: () => void;
  },
): JSX.Element {
  const [closed, setClosed] = createSignal<ReadonlySet<string>>(new Set());
  const entries = createMemo(() => changeTree(props.rows, closed()));
  let list: HTMLDivElement | undefined;

  const setFolder = (key: string, open: boolean) =>
    setClosed((s) => {
      if (s.has(key) !== open) return s; // もうその状態
      const next = new Set(s);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });

  const ctx = {
    get onSelect() {
      return props.onSelect;
    },
    get onShjKey() {
      return props.onShjKey;
    },
    get onExplorer() {
      return props.onExplorer;
    },
    get onLeave() {
      return props.onLeave;
    },
    entries,
    rowEls: () =>
      list ? [...list.querySelectorAll<HTMLElement>(".changes-row")] : [],
    setFolder,
  };

  return (
    <section class="changes" aria-label={props.label}>
      <Show when={props.onResizeStart}>
        {(start) => (
          <div
            class="changes-resizer"
            data-border="changes"
            aria-hidden="true"
            onPointerDown={(e) =>
              start()(e, list?.getBoundingClientRect().height ?? 0)
            }
            onDblClick={() => props.onResizeReset?.()}
          />
        )}
      </Show>
      <h3 class="changes-title">
        CHANGES
        <span class="changes-base" data-base={props.base}>
          {changesBaseLabel(props.base)}
        </span>
        <span class="changes-count">{props.rows.length}</span>
      </h3>
      <Show
        when={props.rows.length > 0}
        fallback={<p class="changes-empty">変更はありません</p>}
      >
        <div
          class="changes-list"
          role="tree"
          aria-label={props.label}
          ref={list}
        >
          {/* 位置で使い回す（フォルダの開閉で行が増減しても、フォーカスしている要素が残る） */}
          <Index each={entries()}>
            {(en) => (
              <ChangeTreeRow
                entry={en()}
                onPress={() => {
                  if (en().kind === "dir") setFolder(en().key, !en().expanded);
                  else if (en().row) props.onSelect(en().row!.path);
                }}
                onKeyDown={(e) => {
                  const a = changesKey(en(), e);
                  if (a && runChangesAction(ctx, en(), e.currentTarget, a)) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }}
              />
            )}
          </Index>
        </div>
      </Show>
    </section>
  );
}
