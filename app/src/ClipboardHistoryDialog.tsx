// クリップボードの履歴の一覧（#54）。キーで開き、選んだ文字を今の欄に貼るか、OS のクリップボードに戻す。
// 履歴を持つのは Tauri の側（clipboard_history.rs）。ここは開くたびに読み、選ばせる。
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";

import { copiedNotice } from "./CopiedToast.tsx";
import {
  ago,
  filterEntries,
  isHistoryKey,
  moveSelection,
  preview,
  type HistoryEntry,
} from "./clipboardHistory.ts";
import { listClipboardHistory } from "./clipboardHistoryOs.ts";
import { copyAndNotify } from "./copiedNotice.ts";
import { ModalCard } from "./connect/Card.tsx";
import { IS_MAC } from "./guiKeys.ts";
import type { KeyLike } from "./guiKeys.ts";
import { writeOs } from "./terminal/clipboardOs.ts";
import { focusedPasteTarget } from "./terminal/pasteTarget.ts";

interface Opened {
  /** 開いたときにキーが向いていた欄に貼る関数（無ければ貼れない） */
  paste?: (text: string) => void;
}

const [opened, setOpened] = createSignal<Opened | undefined>();

/** 開くキーなら窓を出して true（呼んだ側は、そのキーを端末に渡さない）。出ている間に押されても true。 */
export function handleClipboardHistoryKey(e: KeyLike): boolean {
  if (!isHistoryKey(e, IS_MAC)) return false;
  // 窓を出すと欄からフォーカスが外れるので、宛先は先に決める
  if (!opened()) setOpened({ paste: focusedPasteTarget() });
  return true;
}

/** 履歴の窓。開いていなければ何も出さない。 */
export function ClipboardHistoryDialog(): JSX.Element {
  return (
    <Show when={opened()} keyed>
      {(o) => <History opened={o} />}
    </Show>
  );
}

function History(props: { opened: Opened }): JSX.Element {
  const close = () => setOpened(undefined);
  const [entries, setEntries] = createSignal<HistoryEntry[] | undefined>();
  const [failed, setFailed] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [sel, setSel] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(tick));
  listClipboardHistory().then(setEntries, () => setFailed(true));

  let list: HTMLUListElement | undefined;
  const shown = createMemo(() => filterEntries(entries() ?? [], query()));
  const selectedIndex = () => Math.min(sel(), shown().length - 1);
  const selected = () => shown()[selectedIndex()];

  // 選んだ行が見える所へ
  createEffect(() => {
    const i = selectedIndex();
    queueMicrotask(() =>
      list?.children[i]?.scrollIntoView?.({ block: "nearest" }),
    );
  });

  function paste() {
    const e = selected();
    if (!e || !props.opened.paste) return;
    const target = props.opened.paste;
    close();
    target(e.text);
  }
  function putBack() {
    const e = selected();
    if (!e) return;
    close();
    void copyAndNotify(
      () =>
        writeOs({ kind: "text", text: e.text }).then(
          () => true,
          () => false,
        ),
      () => copiedNotice.show(),
    );
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) =>
        moveSelection(i, e.key === "ArrowDown" ? 1 : -1, shown().length),
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Shift+Enter は OS のクリップボードに戻す。Enter は貼る（貼る欄が無ければ戻す）
      if (e.shiftKey || !props.opened.paste) putBack();
      else paste();
    }
  }

  return (
    <ModalCard label="クリップボードの履歴" onCancel={close}>
      <div class="card-body">
        <h1 class="card-title">クリップボードの履歴</h1>
        <input
          class="card-input"
          type="text"
          placeholder="文字を打って絞り込む"
          aria-label="絞り込み"
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
          ref={(el) => queueMicrotask(() => el.focus())}
        />
        <p class="card-text history-hint">
          ↑↓ で選ぶ・Enter で
          {props.opened.paste ? "貼る" : "クリップボードに戻す"}・Shift+Enter
          でクリップボードに戻す・Esc で閉じる
        </p>
      </div>
      <Show
        when={shown().length > 0}
        fallback={
          <p class="card-empty history-empty">
            {failed()
              ? "履歴を読めませんでした"
              : entries() === undefined
                ? "読み込んでいます"
                : entries()!.length === 0
                  ? "履歴はまだありません"
                  : "当てはまるものがありません"}
          </p>
        }
      >
        <ul
          class="card-rows history-rows"
          role="listbox"
          aria-label="履歴"
          ref={list}
        >
          <For each={shown()}>
            {(e, i) => (
              <li role="presentation">
                <button
                  type="button"
                  class="card-row"
                  role="option"
                  tabIndex={-1}
                  aria-selected={i() === selectedIndex()}
                  title={preview(e.text, 400)}
                  onClick={() => setSel(i())}
                  onDblClick={() => (props.opened.paste ? paste() : putBack())}
                >
                  <span class="card-row-name">{preview(e.text)}</span>
                  <span class="card-row-state">{ago(e.copiedAt, now())}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="card-actions">
        <button type="button" class="card-button" onClick={close}>
          閉じる
        </button>
        <button
          type="button"
          class="card-button"
          disabled={!selected()}
          onClick={putBack}
        >
          クリップボードに戻す
        </button>
        <button
          type="button"
          class="card-button primary"
          disabled={!selected() || !props.opened.paste}
          onClick={paste}
        >
          貼る
        </button>
      </div>
    </ModalCard>
  );
}
