// クリップボードの履歴の一覧の中身（#54）。メインウィンドウの履歴の窓（ui/main-window/clipboard/ClipboardHistoryDialog.tsx）と、
// kisui-terminal の外から開く小さな窓（ui/utilities/clipboard/page.tsx。#95）の両方が使う。
// 履歴を持つのは Tauri の側（clipboard_history.rs）。ここは出すたびに読み（props.list）、選ばせる。
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
  historyKey,
  moveSelection,
  preview,
  type HistoryEntry,
  type ListClipboardHistory,
} from "../../../features/clipboard/history.ts";
import { basicHints } from "../../../features/commands/placeKeys.ts";
// 一覧の見た目（.history-*）は、カードの決まりと同じファイルにある
import "../../components/card.css";
import {
  CardBody,
  CardFooter,
  CardText,
  CardTitle,
} from "../../components/Card.tsx";
import { Input } from "../../components/Field.tsx";
import { KeyHints } from "../../components/KeyHints.tsx";

/** クリップボードに戻したと「コピーしました」を見せておく時間（ミリ秒）。 */
const COPIED_MS = 600;

/**
 * 履歴の一覧の中身（見出し・✕・絞り込み・一覧・下の段の基本操作のヒント）。出すたびに履歴を読む。
 * onPaste が無ければ貼れない（Enter はクリップボードに戻す）。窓を閉じるのは、onPaste・onClose を渡した側。
 * onPutBack はクリップボードに書くだけで、書けたかを返す。書けたら「コピーしました」を COPIED_MS だけ出してから onClose を呼ぶ。
 * outside は kisui-terminal の外から開いた窓（貼る操作は無い）。
 * onHelp を渡すと、絞り込みが空のときの `?` で呼ぶ（キーの一覧を出すのは渡した側）。渡さなければ `?` は入力欄に入る字で、下の段にも出さない。
 */
export function HistoryPanel(props: {
  /** 履歴を読む（出すたびに 1 回） */
  list: ListClipboardHistory;
  onPaste?: (text: string) => void;
  onPutBack: (text: string) => Promise<boolean>;
  onClose: () => void;
  outside?: boolean;
  onHelp?: () => void;
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
  props.list().then(setEntries, () => setFailed(true));

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

  /** `?` が今効くか（キーの一覧を出せる窓で、絞り込みが空の間だけ） */
  const helpOn = () => !!props.onHelp && query() === "";

  function onKeyDown(e: KeyboardEvent) {
    const k = historyKey(e, helpOn());
    if (!k) return;
    e.preventDefault();
    switch (k.kind) {
      case "step":
        setSel((i) => moveSelection(i, k.step, shown().length));
        break;
      // Enter は貼る（貼る欄が無ければ戻す）。Shift+Enter は OS のクリップボードに戻す
      case "choose":
        choose();
        break;
      case "putBack":
        void putBack();
        break;
      case "help":
        props.onHelp?.();
        break;
    }
  }

  return (
    <>
      <CardBody>
        <div class="history-head">
          <CardTitle>{T("history.label")}</CardTitle>
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
        <Input
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
      </CardBody>
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
      {/* 下の段（共通フッタ）。クリップボードに戻したら、ヒントの代わりに「コピーしました」を出す。
          知らせ（role="status"）にするのは「コピーしました」だけ（ヒントは、字を打つたびに `?` が出入りするので、読み上げさせない） */}
      <CardFooter>
        <CardBody>
          <Show
            when={!copied()}
            fallback={
              <CardText class="history-copied" role="status">
                {T("history.copied")}
              </CardText>
            }
          >
            <KeyHints
              items={basicHints({
                select: ["↓", "↑"],
                decide: props.onPaste
                  ? T("history.keys.paste")
                  : T("history.keys.copy"),
                help: helpOn(),
                end: "close",
              })}
            />
          </Show>
        </CardBody>
      </CardFooter>
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
