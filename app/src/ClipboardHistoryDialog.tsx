// クリップボードの履歴の一覧（#54）。キーで開き、選んだ文字を今の欄に貼るか、OS のクリップボードに戻す。
// 履歴を持つのは Tauri の側（clipboard_history.rs）。ここは開くたびに読み、選ばせる。
// 一覧の中身（HistoryPanel）は、kisui-terminal の外から開く小さな窓（ClipboardHistoryPopup.tsx）でも使う。
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
  emptyMessage,
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
  const target = props.opened.paste;
  return (
    <ModalCard label="クリップボードの履歴" onCancel={close}>
      <HistoryPanel
        onPaste={
          target &&
          ((text) => {
            close();
            target(text);
          })
        }
        onPutBack={(text) => {
          close();
          void copyAndNotify(
            () =>
              writeOs({ kind: "text", text }).then(
                () => true,
                () => false,
              ),
            () => copiedNotice.show(),
          );
        }}
        onClose={close}
      />
    </ModalCard>
  );
}

/**
 * 履歴の一覧の中身（見出し・絞り込み・一覧・ボタン）。出すたびに履歴を読む。
 * onPaste が無ければ貼れない（Enter はクリップボードに戻す）。窓を閉じるのは、onPaste・onPutBack・onClose を渡した側。
 * outside は kisui-terminal の外から開いた窓（貼るボタンを出さず、戻したあとに自分で貼ることを案内する）。
 */
export function HistoryPanel(props: {
  onPaste?: (text: string) => void;
  onPutBack: (text: string) => void;
  onClose: () => void;
  outside?: boolean;
}): JSX.Element {
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
    if (!e || !props.onPaste) return;
    props.onPaste(e.text);
  }
  function putBack() {
    const e = selected();
    if (!e) return;
    props.onPutBack(e.text);
  }

  // 貼る欄があれば貼り、無ければクリップボードに戻す
  function choose() {
    if (props.onPaste) paste();
    else putBack();
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
      if (e.shiftKey) putBack();
      else choose();
    }
  }

  return (
    <>
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
          <Show when={!props.outside} fallback={outsideHint()}>
            ↑↓ で選ぶ・Enter で{props.onPaste ? "貼る" : "クリップボードに戻す"}
            ・Shift+Enter でクリップボードに戻す・Esc で閉じる
          </Show>
        </p>
      </div>
      <Show
        when={shown().length > 0}
        fallback={
          <p class="card-empty history-empty">
            {emptyMessage(failed(), entries())}
          </p>
        }
      >
        <HistoryRows
          entries={shown()}
          selectedIndex={selectedIndex()}
          now={now()}
          onSelect={setSel}
          onChoose={choose}
          listRef={(el) => (list = el)}
        />
      </Show>
      <HistoryActions
        canPutBack={!!selected()}
        canPaste={!!selected() && !!props.onPaste}
        showPaste={!props.outside}
        onClose={props.onClose}
        onPutBack={putBack}
        onPaste={paste}
      />
    </>
  );
}

/** 外から開いた窓の案内。貼るのはユーザー（kisui-terminal からは貼る操作を送らない）。 */
function outsideHint(): string {
  const paste = IS_MAC ? "Cmd+V" : "Ctrl+V";
  return `↑↓ で選ぶ・Enter でクリップボードに戻す（そのあと ${paste} で貼る）・Esc で閉じる`;
}

/** 履歴の一覧。選んでいる行は selectedIndex。 */
function HistoryRows(props: {
  entries: HistoryEntry[];
  selectedIndex: number;
  now: number;
  onSelect: (i: number) => void;
  onChoose: () => void;
  listRef: (el: HTMLUListElement) => void;
}): JSX.Element {
  return (
    <ul
      class="card-rows history-rows"
      role="listbox"
      aria-label="履歴"
      ref={props.listRef}
    >
      <For each={props.entries}>
        {(e, i) => (
          <li role="presentation">
            <button
              type="button"
              class="card-row"
              role="option"
              tabIndex={-1}
              aria-selected={i() === props.selectedIndex}
              title={preview(e.text, 400)}
              // 入力欄からフォーカスを動かさない（押したあとも↑↓と Enter が効くように）
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => props.onSelect(i())}
              onDblClick={props.onChoose}
            >
              <span class="card-row-name">{preview(e.text)}</span>
              <span class="card-row-state">{ago(e.copiedAt, props.now)}</span>
            </button>
          </li>
        )}
      </For>
    </ul>
  );
}

/** 下のボタン列（閉じる・クリップボードに戻す・貼る）。showPaste でなければ貼るを出さず、戻すを主のボタンにする。 */
function HistoryActions(props: {
  canPutBack: boolean;
  canPaste: boolean;
  showPaste: boolean;
  onClose: () => void;
  onPutBack: () => void;
  onPaste: () => void;
}): JSX.Element {
  return (
    <div class="card-actions">
      <button type="button" class="card-button" onClick={props.onClose}>
        閉じる
      </button>
      <button
        type="button"
        class="card-button"
        classList={{ primary: !props.showPaste }}
        disabled={!props.canPutBack}
        onClick={props.onPutBack}
      >
        クリップボードに戻す
      </button>
      <Show when={props.showPaste}>
        <button
          type="button"
          class="card-button primary"
          disabled={!props.canPaste}
          onClick={props.onPaste}
        >
          貼る
        </button>
      </Show>
    </div>
  );
}
