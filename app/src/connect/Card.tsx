// 窓のカード（モック Connect.dc.html のカードと同じ決まり）。
// リモートを足す窓・名前を変える窓・kisui を入れるかの確認・ssh の質問の窓は、真ん中に出して後ろを触らせないもの（ModalCard）。
// つながらない・引き継がれた・新しい版の知らせは、右下に積んで後ろも触れるもの（.card-notice。Notices.tsx）。
// 寸法と色は card.css。
import { onCleanup, onMount, type JSX } from "solid-js";

import { isCancelKey } from "./cancelKey.ts";
import "./card.css";

/**
 * 真ん中に出すカード。出したら showModal で後ろを触らせず、Esc で onCancel を呼ぶ
 * （dialog は自分では閉じない。閉じるのは呼んだ側が出すのをやめたとき）。
 * Esc の keydown は preventDefault する。しないと macOS の WKWebView が AppKit に渡し、
 * 全画面の窓では全画面まで解けてしまうため。
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
  /** 窓の外（暗くした背景）を押したら onCancel を呼ぶ。省くと呼ばない（打ちかけの入力を、押し違いで失わないため） */
  closeOnOutside?: boolean;
  children: JSX.Element;
}): JSX.Element {
  let el!: HTMLDialogElement;
  const before =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  // keydown で onCancel を呼んだ直後に cancel が来ても、二重に呼ばない。
  // keydown の既定動作（cancel）はマイクロタスクより後なので、戻すのは setTimeout で次のタスクまで待つ
  let handled = false;
  // 背景（::backdrop）のイベントは、target が dialog そのもの。窓の中の余白と分けるため、位置が矩形の外かも見る
  let downOnBackdrop = false;
  const onBackdrop = (e: MouseEvent): boolean => {
    if (e.target !== el) return false;
    const r = el.getBoundingClientRect();
    return (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    );
  };
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
        if (e.defaultPrevented || !isCancelKey(e)) return;
        e.preventDefault();
        handled = true;
        setTimeout(() => (handled = false), 0);
        props.onCancel();
      }}
      onPointerDown={(e) => {
        downOnBackdrop = onBackdrop(e);
      }}
      onClick={(e) => {
        // 押し始めも離したのも背景のときだけ閉じる（窓の中でつかんだドラッグを、外で離したときに閉じない）
        const down = downOnBackdrop;
        downOnBackdrop = false;
        if (props.closeOnOutside && down && onBackdrop(e)) props.onCancel();
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
