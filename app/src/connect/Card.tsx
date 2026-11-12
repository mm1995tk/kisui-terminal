// 窓のカード（モック Connect.dc.html のカードと同じ決まり）。
// リモートを足す窓・名前を変える窓・kisui を入れるかの確認・ssh の質問の窓は、真ん中に出して後ろを触らせないもの（ModalCard）。
// つながらない・引き継がれた・新しい版の知らせは、右下に積んで後ろも触れるもの（.card-notice。Notices.tsx）。
// 寸法と色は card.css。
import { onCleanup, onMount, type JSX } from "solid-js";

import { isCancelKey } from "./cancelKey.ts";
import "./card.css";

/**
 * 真ん中に出すカード。出したら showModal で後ろを触らせず、Esc で onCancel を呼ぶ
 * （Esc の keydown を preventDefault する。しないと macOS の WKWebView が AppKit に渡し、
 * 全画面の窓では全画面まで解けてしまう）
 * （dialog は自分では閉じない。閉じるのは呼んだ側が出すのをやめたとき）。
 * 出すのをやめたら close() し、開く前にフォーカスがあった要素へフォーカスを戻す
 * （DOM から外すだけでは close() を通らず、ブラウザが戻さないため）。
 * focusSelf なら、中のボタンや入力欄ではなく窓そのものにフォーカスを置く
 * （ユーザーの操作と関係なく開く窓で、打っていた Enter がボタンを押さないように）。
 */
export function ModalCard(props: {
  label: string;
  onCancel: () => void;
  /** 幅（px）。省くとモックの 560px */
  width?: number;
  focusSelf?: boolean;
  children: JSX.Element;
}): JSX.Element {
  let el!: HTMLDialogElement;
  const before =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  // keydown で onCancel を呼んだ直後に cancel が来ても、二重に呼ばない
  let handled = false;
  onMount(() => {
    // 取れない WebView では開いたまま（open）の素の窓になる
    if (!el.open) el.showModal?.();
    if (!el.open) el.setAttribute("open", "");
    if (props.focusSelf) el.focus();
  });
  // Solid は DOM から外す前に onCleanup を呼ぶので、ここで close() が効く
  onCleanup(() => {
    if (el.open) el.close();
    if (before?.isConnected) before.focus({ preventScroll: true });
  });
  return (
    <dialog
      ref={el}
      class="card card-modal"
      style={props.width ? { width: `${props.width}px` } : undefined}
      aria-label={props.label}
      tabIndex={props.focusSelf ? -1 : undefined}
      onKeyDown={(e) => {
        if (!isCancelKey(e)) return;
        e.preventDefault();
        handled = true;
        queueMicrotask(() => (handled = false));
        props.onCancel();
      }}
      onCancel={(e) => {
        e.preventDefault();
        if (handled) return;
        props.onCancel();
      }}
    >
      {props.children}
    </dialog>
  );
}
