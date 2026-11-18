// ボタン。窓（ModalCard）と右下の知らせ（Notices）の下の並び（.card-actions）で使う。
// 目的・使う場面・使わない場面・状態・キーの決まりは docs/design/design-system.md の「ボタン」。寸法と色は button.css。
import type { JSX } from "solid-js";

import "./button.css";

/**
 * 押して 1 つの操作をするボタン。字は翻訳の表から引いて children に渡す。
 * Enter・Space で押せ、Tab でフォーカスが移る（ふつうの button と同じ。キーを足さない）。
 * busy の間は押せなくし、aria-busy を立てる（字を「…しています」に変えるのは呼ぶ側）。
 */
export function Button(props: {
  /** 主の操作（窓に 1 つ、並びの右端）なら "primary"。省くと "secondary"（やめる・閉じる・ほかの操作） */
  variant?: "primary" | "secondary";
  /** 省くと "button"。form の中で送るボタンだけ "submit"（Enter で送れる） */
  type?: "button" | "submit";
  /** 今は押せない */
  disabled?: boolean;
  /** 処理中。押せなくし、読み上げにも処理中と伝える */
  busy?: boolean;
  onClick?: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type={props.type ?? "button"}
      class="button"
      data-variant={props.variant ?? "secondary"}
      disabled={props.disabled || props.busy}
      aria-busy={props.busy ? "true" : undefined}
      onClick={() => props.onClick?.()}
    >
      {props.children}
    </button>
  );
}
