// 内蔵ブラウザのブックマークの一覧（#205。ブラウザのタブの窓の B）。字を打って題か URL で絞り込み、Enter で今のワークスペースの新しいタブに開く。
// Ctrl+D で選んでいるものを消す。キーの判定は bookmarks.ts の bookmarkKey、`?` の一覧の表は placeKeys.ts の bookmarks。
// 見た目はクリップボードの履歴（ClipboardHistoryDialog.tsx）と同じカードの一覧。
import { T } from "../../../../i18n/index.ts";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type JSX,
} from "solid-js";

import { leaderKeyName } from "../../../../features/commands/commands.ts";
import { ModalCard, CardBody, CardTitle } from "../../../components/Card.tsx";
import { KeyFooter } from "../../../components/KeyFooter.tsx";
import { basicHints } from "../../../../features/commands/placeKeys.ts";
import { moveSelection } from "../../../../features/clipboard/history.ts";
import { IS_MAC } from "../../../../features/commands/guiKeys.ts";
import { openKeyList } from "../../commands/KeyListDialog.tsx";
import {
  bookmarkKey,
  type Bookmark,
} from "../../../../features/browser/bookmarks.ts";
import {
  bookmarkRows,
  toggleFolder,
  type BookmarkRow,
  type ChromeNode,
} from "../../../../features/browser/bookmarkTree.ts";
import "./browser.css";
import { Input } from "../../../components/Field.tsx";

/** 一覧の 1 行（フォルダか、ブックマーク）。フォルダは深さだけ字下げする。 */
function BookmarkDialogRow(props: {
  row: BookmarkRow;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}): JSX.Element {
  const r = props.row;
  return (
    <li role="presentation">
      <button
        type="button"
        class="card-row"
        role="option"
        tabIndex={-1}
        aria-selected={props.selected}
        aria-expanded={r.kind === "folder" ? r.open : undefined}
        style={{ "padding-left": `${0.75 + r.depth * 1.25}em` }}
        title={r.kind === "folder" ? r.name : r.bookmark.url}
        // 入力欄からフォーカスを動かさない（押したあとも↑↓と Enter が効くように）
        onMouseDown={(ev) => ev.preventDefault()}
        onClick={props.onSelect}
        onDblClick={props.onOpen}
      >
        {r.kind === "folder" ? (
          <span class="card-row-name bookmark-folder">
            {r.open ? "▾ " : "▸ "}
            {r.name}
          </span>
        ) : (
          <>
            <span class="card-row-name">
              {r.bookmark.title || r.bookmark.url}
            </span>
            <Show when={r.bookmark.source === "chrome"}>
              <span class="bookmark-source">{T("bookmarks.chrome")}</span>
            </Show>
            <span class="card-row-state bookmark-url">{r.bookmark.url}</span>
          </>
        )}
      </button>
    </li>
  );
}

/** ブックマークの一覧のダイアログ。list が undefined なら読み込み中、failed なら読めなかった。 */
export function BookmarkDialog(props: {
  /** kisui-terminal 自身のブックマーク（undefined は読み込み中） */
  own: readonly Bookmark[] | undefined;
  /** Chrome のブックマークの木（#275。undefined は読み込み中） */
  chrome: readonly ChromeNode[] | undefined;
  failed: boolean;
  onOpen: (b: Bookmark) => void;
  onDelete: (b: Bookmark) => void;
  onCancel: () => void;
}): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [sel, setSel] = createSignal(0);
  let rows: HTMLUListElement | undefined;
  /** 開け閉めを逆にしたフォルダ（根は最初から開き、その下は閉じている。bookmarkRows） */
  const [flipped, setFlipped] = createSignal<ReadonlySet<string>>(new Set());
  const shown = createMemo(() =>
    bookmarkRows(props.own, props.chrome, flipped(), query()),
  );
  const selectedIndex = () => Math.max(0, Math.min(sel(), shown().length - 1));
  const selected = () => shown()[selectedIndex()];
  /** 選んでいる行がフォルダなら開け閉めし、ブックマークなら開く */
  const activate = (r: BookmarkRow | undefined) => {
    if (!r) return;
    if (r.kind === "folder") setFlipped((s) => toggleFolder(s, r.key));
    else props.onOpen(r.bookmark);
  };

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
      case "open":
        activate(selected());
        break;
      case "delete": {
        const r = selected();
        if (r?.kind === "bookmark") props.onDelete(r.bookmark);
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
      : props.own === undefined && props.chrome === undefined
        ? T("bookmarks.empty.loading")
        : query().trim() === ""
          ? T("bookmarks.empty.none", { leader: leaderKeyName(IS_MAC) })
          : T("bookmarks.empty.noMatch");

  return (
    <ModalCard
      label={T("bookmarks.title")}
      onCancel={props.onCancel}
      header={<CardTitle>{T("bookmarks.title")}</CardTitle>}
      footer={
        // `?` は、絞り込みが空の間だけ効くので、その間だけ出す。消す（Ctrl+D）は `?` の一覧に出す
        <KeyFooter
          items={basicHints({
            select: ["↓", "↑"],
            decide: T("bookmarks.keys.open"),
            help: query() === "",
            end: "close",
          })}
        />
      }
    >
      <CardBody>
        <Input
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
      </CardBody>
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
            {(r, i) => (
              <BookmarkDialogRow
                row={r}
                selected={i() === selectedIndex()}
                onSelect={() => {
                  setSel(i());
                  // フォルダは 1 回押すと開け閉めする（ブックマークは、2 回押すと開く）
                  if (r.kind === "folder") activate(r);
                }}
                onOpen={() => {
                  if (r.kind === "bookmark") props.onOpen(r.bookmark);
                }}
              />
            )}
          </For>
        </ul>
      </Show>
    </ModalCard>
  );
}
