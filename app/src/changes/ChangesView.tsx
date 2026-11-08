// 差分モードの CHANGES の一覧（ファイルエクスプローラの下）を、TUI の CHANGES と同じフォルダの木で描く。
// 行を押す（Enter・l・o でも）と、そのファイルの差分を shj に出させる。フォルダの行は押すと開け閉めする。
// shj が今差分を出しているファイルの行は強調する。見た目は changes.css。
// 行にフォーカスがあるときは TUI と同じキーで動かせる（#45。割り当ては keys.ts）。
import { createMemo, createSignal, Index, Show, type JSX } from "solid-js";

import type { ChangesShjKey } from "../rpc/protocol.ts";
import {
  changesKey,
  moveIndex,
  spaceFollow,
  type ChangesAction,
} from "./keys.ts";
import { changeTree, type ChangeEntry, type ChangeRow } from "./model.ts";
import "./changes.css";

/** 一覧のそとへ頼むこと（shj・端末・エクスプローラは App が知っている）。 */
export interface ChangesHandlers {
  /** 変更の行を押した・開いた（path は ChangeRow.path） */
  onSelect: (path: string) => void;
  /** shj の CHANGES のキー（s・r・R・Space・: と Space の続き） */
  onShjKey?: (key: ChangesShjKey) => void;
  /** エクスプローラに移る（Tab） */
  onExplorer?: () => void;
  /** 端末に戻る（Esc・q） */
  onLeave?: () => void;
}

/**
 * CHANGES の一覧。label は一覧の読み上げの名前。
 * rows の順番は shj が見せる順。閉じたフォルダは、この一覧が覚えている（描き直しても残る）。
 */
export function ChangesView(
  props: ChangesHandlers & {
    rows: ChangeRow[];
    label: string;
  },
): JSX.Element {
  const [closed, setClosed] = createSignal<ReadonlySet<string>>(new Set());
  const entries = createMemo(() => changeTree(props.rows, closed()));
  let list: HTMLDivElement | undefined;
  // Space を押して、続きの 1 文字（w など）を待っている間。続きも shj に渡す
  let spacePending = false;

  const setFolder = (key: string, open: boolean) =>
    setClosed((s) => {
      if (s.has(key) !== open) return s; // もうその状態
      const next = new Set(s);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });

  const rowEls = () =>
    list ? [...list.querySelectorAll<HTMLElement>(".changes-row")] : [];

  /** 押した・キーで開いた行の操作。 */
  const press = (en: ChangeEntry) => {
    if (en.kind === "dir") setFolder(en.key, !en.expanded);
    else if (en.row) props.onSelect(en.row.path);
  };

  /** 行 el でキーを押した。何かしたら true。 */
  const run = (en: ChangeEntry, el: HTMLElement, a: ChangesAction): boolean => {
    switch (a.kind) {
      case "move": {
        // 端で動けなくても、↑ ↓ で一覧がスクロールしないように止める
        const j = moveIndex(entries(), rowEls().indexOf(el), a.to);
        const next = rowEls()[j];
        next?.focus();
        next?.scrollIntoView({ block: "nearest" });
        return true;
      }
      case "folder":
        setFolder(en.key, a.op === "toggle" ? !en.expanded : a.op === "open");
        return true;
      case "open":
        if (en.row) props.onSelect(en.row.path);
        return true;
      case "shj":
        if (!props.onShjKey) return false;
        spacePending = a.key === "space";
        props.onShjKey(a.key);
        return true;
      case "explorer":
        if (!props.onExplorer) return false;
        props.onExplorer();
        return true;
      case "leave":
        if (!props.onLeave) return false;
        props.onLeave();
        return true;
    }
  };

  return (
    <section class="changes" aria-label={props.label}>
      <h3 class="changes-title">
        CHANGES<span class="changes-count">{props.rows.length}</span>
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
            {(en) => {
              const r = () => en().row;
              return (
                <div
                  class="changes-row"
                  role="treeitem"
                  aria-level={en().depth + 1}
                  aria-expanded={
                    en().kind === "dir" ? en().expanded : undefined
                  }
                  aria-selected={r()?.selected ? "true" : "false"}
                  data-kind={en().kind}
                  data-letter={r()?.letter}
                  data-key={en().key}
                  style={{ "--changes-depth": String(en().depth) }}
                  title={en().key}
                  tabIndex={0}
                  onClick={() => press(en())}
                  onKeyDown={(e) => {
                    if (spacePending) {
                      spacePending = false;
                      const follow = spaceFollow(e);
                      if (follow && props.onShjKey) {
                        props.onShjKey(follow);
                        e.preventDefault();
                        e.stopPropagation();
                      }
                      return; // Esc などは待ちをやめるだけ
                    }
                    const a = changesKey(en(), e);
                    if (!a) return;
                    if (run(en(), e.currentTarget, a)) {
                      e.preventDefault();
                      e.stopPropagation();
                    }
                  }}
                >
                  <Show
                    when={en().kind === "dir"}
                    fallback={<span class="changes-chevron" />}
                  >
                    <svg
                      class="changes-chevron"
                      width="12"
                      height="12"
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                    >
                      <path
                        d={en().expanded ? "M4 6l4 4 4-4" : "M6 4l4 4-4 4"}
                      />
                    </svg>
                  </Show>
                  <span class="changes-name">{en().name}</span>
                  <Show when={en().kind === "dir"}>
                    <span class="changes-dircount">{en().count}</span>
                  </Show>
                  <Show when={r()}>
                    {(row) => (
                      <>
                        <Show when={row().added > 0}>
                          <span class="changes-added">+{row().added}</span>
                        </Show>
                        <Show when={row().deleted > 0}>
                          <span class="changes-deleted">-{row().deleted}</span>
                        </Show>
                        <span
                          class="changes-mark"
                          role="img"
                          aria-label={row().label}
                        >
                          {row().letter}
                        </span>
                      </>
                    )}
                  </Show>
                </div>
              );
            }}
          </Index>
        </div>
      </Show>
    </section>
  );
}
