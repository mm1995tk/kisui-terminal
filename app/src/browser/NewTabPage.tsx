// 内蔵ブラウザの「新しいタブのページ」（#238）。リーダーの o n・o N と「+」のメニューの「ブラウザ」で開いたタブの、まだ何も開いていない間の中身。
// 検索窓（打ったものは URL バーと同じ決まりで、URL なら開き、そうでなければ Google で探す。tabs.ts の urlOrSearch）と、ブックマークの一覧を出す。
// webview は作らず、画面（DOM）が描く。出たら検索窓にキーがある。キーだけで使える：打つとブックマークを絞り込み、`↓` `↑`（Ctrl+J / Ctrl+K）で選び、
// `Enter` で選んだブックマークか打ったものを開く。ブックマークはマウスで押して開いてもよい。
// 開くと、そのタブがそのページになる（App.tsx の submitUrlBar）。
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
import { IS_MAC } from "../guiKeys.ts";
import { filterBookmarks, type Bookmark } from "./bookmarks.ts";
import { moveSelection, newTabKey, type NewTabKey } from "./newTab.ts";
import { urlOrSearch } from "./tabs.ts";
import "./browser.css";

/** ブックマークが 1 つも出ないときの文（読めなかった・読み込み中・まだ無い・絞り込みに合わない）。 */
function emptyMessage(
  list: readonly Bookmark[] | undefined,
  failed: boolean,
): string {
  if (failed) return T("bookmarks.empty.failed");
  if (list === undefined) return T("bookmarks.empty.loading");
  if (list.length === 0)
    return T("newTab.empty.none", { leader: leaderKeyName(IS_MAC) });
  return T("bookmarks.empty.noMatch");
}

/** ブックマークのタイルの一覧。選んでいるもの（selected。-1 は無し）が見える所へ動かす。押すと onOpen。 */
function BookmarkTiles(props: {
  list: readonly Bookmark[];
  selected: number;
  onOpen: (url: string) => void;
}): JSX.Element {
  let tiles: HTMLUListElement | undefined;
  createEffect(() => {
    const i = props.selected;
    if (i >= 0)
      queueMicrotask(() =>
        tiles?.children[i]?.scrollIntoView?.({ block: "nearest" }),
      );
  });
  return (
    <ul
      class="newtab-tiles"
      aria-label={T("bookmarks.list")}
      ref={(el) => (tiles = el)}
    >
      <For each={props.list}>
        {(b, i) => (
          <li>
            <button
              type="button"
              class="newtab-tile"
              aria-current={i() === props.selected}
              title={b.url}
              // 検索窓からキーを奪わない（押すと開くので、すぐ別のページに替わる）
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => props.onOpen(b.url)}
            >
              <span class="newtab-tile-name">{b.title || b.url}</span>
              <span class="newtab-tile-url">{b.url}</span>
            </button>
          </li>
        )}
      </For>
    </ul>
  );
}

/**
 * 新しいタブのページ。タブが替わるときは作り直す（打ちかけを持ち越さない）。
 * list が undefined ならブックマークを読み込み中、failed なら読めなかった。
 */
export function NewTabPage(props: {
  incognito: boolean;
  list: readonly Bookmark[] | undefined;
  failed: boolean;
  /** 開く URL を渡す（検索窓に打ったものを直した URL か、ブックマークの URL） */
  onOpen: (url: string) => void;
  /** 検索窓にキーを向ける関数を受け取る（リーダーの o u） */
  focusRef: (focus: () => void) => void;
}): JSX.Element {
  let input!: HTMLInputElement;
  const [query, setQuery] = createSignal("");
  const [invalid, setInvalid] = createSignal(false);
  /** -1 は検索窓、0 以上は絞り込んだ一覧の番号 */
  const [sel, setSel] = createSignal(-1);
  const shown = createMemo(() => filterBookmarks(props.list ?? [], query()));
  const selected = () => Math.min(sel(), shown().length - 1);

  const focus = () => {
    input.focus();
    setSel(-1);
  };
  props.focusRef(focus);
  // 出たら検索窓にキーを向ける。リーダーが閉じるのと前後しても取られないよう、描いた後にもう一度向ける
  queueMicrotask(() => input.focus());
  requestAnimationFrame(() => {
    if (
      document.activeElement === null ||
      document.activeElement === document.body
    )
      input.focus();
  });

  /** 検索窓のキー。選びの移動・開く・打ったものを消す（Esc。キーは検索窓に残す。ページがまだ無いので、戻す先が無い）。 */
  function onSearchKey(k: NewTabKey) {
    if (k.kind === "step")
      setSel(() => moveSelection(selected(), k.step, shown().length));
    else if (k.kind === "enter") submit();
    else {
      setQuery("");
      setInvalid(false);
      setSel(-1);
    }
  }

  function submit() {
    const b = shown()[selected()];
    if (b) {
      props.onOpen(b.url);
      return;
    }
    const u = urlOrSearch(query());
    if (u === null) {
      // 空は何もしない。開けないものは知らせる
      setInvalid(query().trim() !== "");
      return;
    }
    props.onOpen(u);
  }

  return (
    <div class="newtab" role="search">
      <div class="newtab-inner">
        <h1 class="newtab-title">
          {props.incognito ? T("newTab.incognito") : T("newTab.title")}
        </h1>
        <Show when={props.incognito}>
          <p class="newtab-note">{T("newTab.incognito.note")}</p>
        </Show>
        <input
          ref={input}
          class="newtab-input"
          type="text"
          inputmode="url"
          spellcheck={false}
          autocomplete="off"
          aria-label={T("newTab.search")}
          placeholder={T("urlBar.placeholder")}
          aria-invalid={invalid()}
          title={invalid() ? T("urlBar.invalid") : undefined}
          value={query()}
          onFocus={() => setSel(-1)}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setInvalid(false);
            setSel(-1);
          }}
          onKeyDown={(e) => {
            const k = newTabKey(e);
            if (!k) return;
            e.preventDefault();
            onSearchKey(k);
          }}
        />
        <p class="newtab-hint">{T("newTab.hint")}</p>
        <h2 class="newtab-heading">{T("newTab.bookmarks")}</h2>
        <Show
          when={shown().length > 0}
          fallback={
            <p class="newtab-empty">{emptyMessage(props.list, props.failed)}</p>
          }
        >
          <BookmarkTiles
            list={shown()}
            selected={selected()}
            onOpen={props.onOpen}
          />
        </Show>
      </div>
    </div>
  );
}
