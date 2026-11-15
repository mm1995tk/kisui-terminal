// 内蔵ブラウザのページ内検索の欄（#205。リーダーの o /、ブラウザを出している間は Cmd+F / Ctrl+F でも）。
// ブラウザを出す場所の下の端に置き、ページはその上まで縮む（data-overlay。BrowserArea.tsx の OVERLAY_SELECTOR）。
// 字を打つたびに探し（今の所から探し直す）、Enter で次、Shift+Enter で前へ。端では折り返す。Esc か × で閉じ、キーをページに戻す。
// 探すのは殻（browser.rs の browser_find。WebKit の window.find）で、見つけた所はページの選択になる。
import { T } from "../i18n/index.ts";
import { createSignal, onCleanup, Show, type JSX } from "solid-js";

import { isCancelKey } from "../connect/cancelKey.ts";
import { findInTab } from "./browserOs.ts";
import "./browser.css";

/** 打ち終えるのを待つ時間（ミリ秒）。打つたびにページで探さないように。 */
const TYPE_WAIT_MS = 120;

/**
 * 内蔵ブラウザのタブ 1 つのページ内検索の欄（入力欄・見つからないときの知らせ・キーの案内・閉じるボタン）。
 * ブラウザを出す場所の下の端に出す。出たら入力欄にキーを向ける。
 */
export function FindBar(props: {
  /** 探すタブ */
  tab: string;
  /** 閉じる（呼んだ側が、キーをページに戻す） */
  onClose: () => void;
  /** 入力欄にキーを向ける関数を受け取る（開いている間にもう一度 Cmd+F を押したとき） */
  focusRef: (focus: () => void) => void;
}): JSX.Element {
  let input!: HTMLInputElement;
  const [query, setQuery] = createSignal("");
  const [found, setFound] = createSignal<boolean | undefined>();
  // 後から出した問い合わせの答えだけを使う（打つのが速いと、前の答えが後に届くことがある）
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  function find(mode: "first" | "next" | "prev") {
    clearTimeout(timer);
    const text = query();
    const mine = ++seq;
    if (text === "") {
      setFound(undefined);
      return;
    }
    findInTab(props.tab, text, mode).then(
      (ok) => {
        if (mine === seq) setFound(ok);
      },
      () => {
        if (mine === seq) setFound(false);
      },
    );
  }

  const focus = () => {
    input.focus();
    input.select();
  };
  props.focusRef(focus);

  return (
    <div
      class="find-bar"
      data-overlay
      role="search"
      aria-label={T("find.label")}
    >
      <input
        ref={(el) => {
          input = el;
          queueMicrotask(focus);
        }}
        class="find-input"
        type="text"
        spellcheck={false}
        autocomplete="off"
        placeholder={T("find.placeholder")}
        aria-label={T("find.label")}
        aria-invalid={found() === false}
        value={query()}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          clearTimeout(timer);
          timer = setTimeout(() => find("first"), TYPE_WAIT_MS);
        }}
        onKeyDown={(e) => {
          if (e.isComposing) return;
          if (isCancelKey(e)) {
            e.preventDefault();
            props.onClose();
          } else if (
            e.key === "Enter" &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey
          ) {
            e.preventDefault();
            find(e.shiftKey ? "prev" : "next");
          }
        }}
      />
      <Show when={found() === false}>
        <span class="find-status" role="status">
          {T("find.notFound")}
        </span>
      </Show>
      <span class="find-hint">{T("find.hint")}</span>
      <button
        type="button"
        class="find-close"
        aria-label={T("find.close")}
        title={T("find.close")}
        onMouseDown={(ev) => ev.preventDefault()}
        onClick={() => props.onClose()}
      >
        ×
      </button>
    </div>
  );
}
