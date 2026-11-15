// 内蔵ブラウザのブックマークの一覧（#205。リーダーの o B）。字を打って題か URL で絞り込み、Enter で今のワークスペースの新しいタブに開く。
// Ctrl+D で選んでいるものを消す。キーの判定は bookmarks.ts の bookmarkKey、`?` の一覧の表は placeKeys.ts の bookmarks。
// 見た目はクリップボードの履歴（ClipboardHistoryDialog.tsx）と同じカードの一覧。
import { T } from "../i18n/index.ts";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type JSX,
} from "solid-js";

import { leaderKeyName } from "../commands.ts";
import { ModalCard } from "../connect/Card.tsx";
import { moveSelection } from "../clipboardHistory.ts";
import { IS_MAC } from "../guiKeys.ts";
import { openKeyList } from "../KeyListDialog.tsx";
import { bookmarkKey, filterBookmarks, type Bookmark } from "./bookmarks.ts";
import "./browser.css";

/** ブックマークの一覧のダイアログ。list が undefined なら読み込み中、failed なら読めなかった。 */
export function BookmarkDialog(props: {
  list: readonly Bookmark[] | undefined;
  failed: boolean;
  onOpen: (b: Bookmark) => void;
  onDelete: (b: Bookmark) => void;
  onCancel: () => void;
}): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [sel, setSel] = createSignal(0);
  let rows: HTMLUListElement | undefined;
  const shown = createMemo(() => filterBookmarks(props.list ?? [], query()));
  const selectedIndex = () => Math.max(0, Math.min(sel(), shown().length - 1));
  const selected = () => shown()[selectedIndex()];

  // 選んだ行が見える所へ
  createEffect(() => {
    const i = selectedIndex();
    queueMicrotask(() =>
      rows?.children[i]?.scrollIntoView?.({ block: "nearest" }),
    );
  });

  function onKeyDown(e: KeyboardEvent) {
    const k = bookmarkKey(e, query() === "");
    if (!k) return;
    e.preventDefault();
    switch (k.kind) {
      case "step":
        setSel((i) => moveSelection(i, k.step, shown().length));
        break;
      case "open": {
        const b = selected();
        if (b) props.onOpen(b);
        break;
      }
      case "delete": {
        const b = selected();
        if (b) props.onDelete(b);
        break;
      }
      case "help":
        openKeyList("bookmarks");
        break;
    }
  }

  const emptyText = () =>
    props.failed
      ? T("bookmarks.empty.failed")
      : props.list === undefined
        ? T("bookmarks.empty.loading")
        : props.list.length === 0
          ? T("bookmarks.empty.none", { leader: leaderKeyName(IS_MAC) })
          : T("bookmarks.empty.noMatch");

  return (
    <ModalCard label={T("bookmarks.title")} onCancel={props.onCancel}>
      <div class="card-body">
        <h1 class="card-title">{T("bookmarks.title")}</h1>
        <input
          class="card-input"
          type="text"
          spellcheck={false}
          autocomplete="off"
          placeholder={T("bookmarks.filterPlaceholder")}
          aria-label={T("bookmarks.filter")}
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
          ref={(el) => queueMicrotask(() => el.focus())}
        />
        <p class="card-text history-hint">{T("bookmarks.hint")}</p>
      </div>
      <Show
        when={shown().length > 0}
        fallback={<p class="card-empty history-empty">{emptyText()}</p>}
      >
        <ul
          class="card-rows bookmark-rows"
          role="listbox"
          aria-label={T("bookmarks.list")}
          ref={(el) => (rows = el)}
        >
          <For each={shown()}>
            {(b, i) => (
              <li role="presentation">
                <button
                  type="button"
                  class="card-row"
                  role="option"
                  tabIndex={-1}
                  aria-selected={i() === selectedIndex()}
                  title={b.url}
                  // 入力欄からフォーカスを動かさない（押したあとも↑↓と Enter が効くように）
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => setSel(i())}
                  onDblClick={() => props.onOpen(b)}
                >
                  <span class="card-row-name">{b.title || b.url}</span>
                  <span class="card-row-state bookmark-url">{b.url}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </ModalCard>
  );
}
