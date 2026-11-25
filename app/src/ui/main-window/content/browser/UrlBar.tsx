// 内蔵ブラウザのページの上の端の URL バー（#232）。ブラウザのタブを出している間、今のページの URL（中継しているタブは中継前の元の URL）を出す。
// 押すか、リーダーの o u で書き換えられる。Enter で開き（URL でなければ Google で検索する。tabs.ts の urlOrSearch）、Esc か、ほかへキーが移ると元の URL に戻す。
// 上の端に置き、ページはその下に下がる（data-overlay-top。overlay.ts の OVERLAY_SELECTORS）。
import { isComposingKey } from "../../../../features/commands/ime.ts";
import { T } from "../../../../i18n/index.ts";
import { createSignal, Show, type JSX } from "solid-js";

import { isCancelKey } from "../../../components/cancelKey.ts";
import { urlOrSearch } from "../../../../features/browser/tabs.ts";
import "./browser.css";

/**
 * 内蔵ブラウザのタブ 1 つの URL バー（戻る・進む・読み込み直すのボタンと、URL の入力欄）。
 * 開いたタブが替わるときは作り直す（打ちかけを持ち越さない）。
 */
export function UrlBar(props: {
  /** 今のページの URL（元の URL） */
  url: string;
  /** 決めた。開く URL を渡す */
  onSubmit: (url: string) => void;
  /** 書き換えをやめた（呼んだ側が、キーをページに戻す） */
  onCancel: () => void;
  /** 戻る・進む・読み込み直す（リーダーの o h・o l・o r と同じ） */
  onNav: (action: "back" | "forward" | "reload") => void;
  /** 読み込み中の進み具合（0〜100。#449）。読み込み中でなければ undefined */
  loading: number | undefined;
  /** 読み込みを止める（リーダーの o c と同じ。読み込み中は、↻ が「×」になる） */
  onStop: () => void;
  /** 入力欄にキーを向ける関数を受け取る（リーダーの o u） */
  focusRef: (focus: () => void) => void;
}): JSX.Element {
  let input!: HTMLInputElement;
  /** 打っている途中のもの。null なら書き換えていない（今の URL を出す） */
  const [draft, setDraft] = createSignal<string | null>(null);
  const [invalid, setInvalid] = createSignal(false);

  props.focusRef(() => input.focus());

  function submit() {
    const u = urlOrSearch(draft() ?? props.url);
    if (u === null) {
      setInvalid(true);
      return;
    }
    setDraft(null);
    props.onSubmit(u);
  }

  const navButton = (label: string, glyph: string, onClick: () => void) => (
    <button
      type="button"
      class="url-bar-button"
      aria-label={label}
      title={label}
      // ボタンを押してもキーを入力欄から奪わない（押したあとは呼んだ側がページにキーを戻す）
      onMouseDown={(ev) => ev.preventDefault()}
      onClick={onClick}
    >
      {glyph}
    </button>
  );

  return (
    <div class="url-bar" data-overlay-top role="search">
      {navButton(T("leader.browser.back"), "←", () => props.onNav("back"))}
      {navButton(T("leader.browser.forward"), "→", () =>
        props.onNav("forward"),
      )}
      {props.loading === undefined
        ? navButton(T("leader.browser.reload"), "↻", () =>
            props.onNav("reload"),
          )
        : navButton(T("leader.browser.stop"), "×", props.onStop)}
      <input
        ref={input}
        class="url-bar-input"
        type="text"
        inputmode="url"
        spellcheck={false}
        autocomplete="off"
        aria-label={T("urlBar.label")}
        placeholder={T("urlBar.placeholder")}
        aria-invalid={invalid()}
        title={invalid() ? T("urlBar.invalid") : undefined}
        value={draft() ?? props.url}
        onFocus={(e) => e.currentTarget.select()}
        onInput={(e) => {
          setDraft(e.currentTarget.value);
          setInvalid(false);
        }}
        onBlur={() => {
          setDraft(null);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (isComposingKey(e)) return;
          if (isCancelKey(e)) {
            e.preventDefault();
            setDraft(null);
            setInvalid(false);
            props.onCancel();
          } else if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      <Show when={props.loading !== undefined}>
        {/* URL バーの下の端の線（ページには重ねず、バーの中に収める） */}
        <div
          class="url-bar-progress"
          role="progressbar"
          aria-label={T("urlBar.loading")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={props.loading}
          style={{ width: `${Math.max(props.loading ?? 0, 8)}%` }}
        />
      </Show>
    </div>
  );
}
