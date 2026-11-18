// クリップボードの履歴の一覧（#54）。キーで開き、選んだ文字を今の欄に貼るか、OS のクリップボードに戻す。
// 履歴を持つのは Tauri の側（clipboard_history.rs）。ここは開くたびに読み、選ばせる。
// 一覧の中身（HistoryPanel）は、kisui-terminal の外から開く小さな窓（ClipboardHistoryPopup.tsx）でも使う。
import { isComposingKey } from "../../../features/commands/ime.ts";
import { T } from "../../../i18n/index.ts";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";

import {
  ago,
  emptyMessage,
  filterEntries,
  moveSelection,
  preview,
  type HistoryEntry,
} from "../../../features/clipboard/history.ts";
import { listClipboardHistory } from "../../../infrastructure/tauri/clipboardHistory.ts";
import { ModalCard } from "../../components/Card.tsx";
import { listStep } from "../../../features/commands/placeKeys.ts";
import { writeOs } from "../../../infrastructure/tauri/clipboard.ts";
import { focusedPasteTarget } from "../content/terminal/pasteTarget.ts";

interface Opened {
  /** 開いたときにキーが向いていた欄に貼る関数（無ければ貼れない） */
  paste?: (text: string) => void;
}

const [opened, setOpened] = createSignal<Opened | undefined>();

/** 履歴の窓を出す（近道の Cmd+Shift+H / Ctrl+Shift+H と、リーダーの `y`）。出ている間は何もしない。 */
export function openClipboardHistory(): void {
  // 窓を出すと欄からフォーカスが外れるので、宛先は先に決める
  if (!opened()) setOpened({ paste: focusedPasteTarget() });
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
    <ModalCard label={T("history.label")} onCancel={close}>
      <HistoryPanel
        onPaste={
          target &&
          ((text) => {
            close();
            target(text);
          })
        }
        onPutBack={(text) =>
          writeOs({ kind: "text", text }).then(
            () => true,
            () => false,
          )
        }
        onClose={close}
      />
    </ModalCard>
  );
}

/** クリップボードに戻したと「コピーしました」を見せておく時間（ミリ秒）。 */
const COPIED_MS = 600;

/**
 * 履歴の一覧の中身（見出し・✕・絞り込み・一覧）。出すたびに履歴を読む。
 * onPaste が無ければ貼れない（Enter はクリップボードに戻す）。窓を閉じるのは、onPaste・onClose を渡した側。
 * onPutBack はクリップボードに書くだけで、書けたかを返す。書けたら「コピーしました」を COPIED_MS だけ出してから onClose を呼ぶ。
 * outside は kisui-terminal の外から開いた窓（貼る操作は無く、案内も短い）。
 */
export function HistoryPanel(props: {
  onPaste?: (text: string) => void;
  onPutBack: (text: string) => Promise<boolean>;
  onClose: () => void;
  outside?: boolean;
}): JSX.Element {
  const [entries, setEntries] = createSignal<HistoryEntry[] | undefined>();
  const [failed, setFailed] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [sel, setSel] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const [copied, setCopied] = createSignal(false);
  let closing: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(closing));
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
    if (!e || !props.onPaste || copied()) return;
    props.onPaste(e.text);
  }
  // 書いている最中の Enter の連打・リピートで、書き込みとタイマーが 2 つにならないようにする
  let busy = false;
  async function putBack() {
    const e = selected();
    if (!e || copied() || busy) return;
    busy = true;
    const ok = await props.onPutBack(e.text);
    busy = false;
    if (!ok) return;
    setCopied(true);
    closing = setTimeout(props.onClose, COPIED_MS);
  }

  // 貼る欄があれば貼り、無ければクリップボードに戻す
  function choose() {
    if (props.onPaste) paste();
    else void putBack();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (isComposingKey(e)) return;
    // ↓ ↑ か Ctrl+J / Ctrl+K で選ぶ行を動かす（入力欄に字を打つので、j k は使えない）
    const step =
      e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : listStep(e);
    if (step !== 0) {
      e.preventDefault();
      setSel((i) => moveSelection(i, step, shown().length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Shift+Enter は OS のクリップボードに戻す。Enter は貼る（貼る欄が無ければ戻す）
      if (e.shiftKey) void putBack();
      else choose();
    }
  }

  return (
    <>
      <div class="card-body">
        <div class="history-head">
          <h1 class="card-title">{T("history.label")}</h1>
          <button
            type="button"
            class="history-close"
            aria-label={T("history.close")}
            title={T("history.close")}
            // 入力欄からフォーカスを動かさない（押したあとも↑↓と Enter が効くように）
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={props.onClose}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M3 3l10 10M13 3L3 13"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                fill="none"
              />
            </svg>
          </button>
        </div>
        <input
          class="card-input"
          type="text"
          placeholder={T("history.filterPlaceholder")}
          aria-label={T("history.filter")}
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
          ref={(el) => queueMicrotask(() => el.focus())}
        />
        <p class="card-text history-hint" role="status">
          <Show
            when={!copied()}
            fallback={<span class="history-copied">{T("history.copied")}</span>}
          >
            {props.outside ? T("history.hint.outside") : T("history.hint")}
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
    </>
  );
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
      aria-label={T("history.list")}
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
