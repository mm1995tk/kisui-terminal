// 窓のカード（モック Connect.dc.html のカードと同じ決まり）。
// リモートを足す窓・kisui を入れるかの確認・ssh の質問の窓は、真ん中に出して後ろを触らせないもの（ModalCard）。
// つながらない・引き継がれた・新しい版の知らせは、右下に積んで後ろも触れるもの（.card-notice。Notices.tsx）。
// 寸法と色は card.css（値は ui/styles/tokens.css）、下に並べるボタンは Button.tsx。使い方の決まりは docs/design/design-system.md の「窓の枠」。
import {
  children,
  onCleanup,
  onMount,
  Show,
  splitProps,
  type JSX,
} from "solid-js";
import { Dynamic } from "solid-js/web";

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
 *
 * 中は 3 つに分ける：上の header（見出し）と下の footer（ボタンの並び・キーの案内）は動かず、
 * 間の children（中身）だけがスクロールする。footer は省ける。header は、中身が自分で見出しを描く窓だけが省く。
 */
export function ModalCard(props: {
  label: string;
  onCancel: () => void;
  /** 幅（px）。省くとモックの 560px */
  width?: number;
  focusSelf?: boolean;
  /** 窓の外（暗くした背景）を押したら onCancel を呼ぶ。省くと呼ばない（打ちかけの入力を、押し違いで失わないため） */
  closeOnOutside?: boolean;
  /** 上に固定する見出し（ふつうは CardTitle）。省けるのは、中身が自分で見出しを描く窓だけ（履歴の一覧 HistoryPanel） */
  header?: JSX.Element;
  /** 下に固定するもの（ふつうは CardActions）。省くと出さない */
  footer?: JSX.Element;
  /** 中身。窓の高さに収まらなければ、ここだけがスクロールする */
  children: JSX.Element;
}): JSX.Element {
  // header・footer は JSX の getter。読むたびに作り直さないよう、1 回だけ解く
  const header = children(() => props.header);
  const footer = children(() => props.footer);
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
      <Show when={header()}>
        <header class="card-header">{header()}</header>
      </Show>
      <div class="card-content">{props.children}</div>
      <Show when={footer()}>
        <footer class="card-footer">{footer()}</footer>
      </Show>
    </dialog>
  );
}

// ---- カードの中の部分（真ん中の窓 ModalCard と、右下の知らせの両方で使う）----
// 並びは card.css と docs/design/design-system.md の「窓の枠」：本文の塊（見出し・文・入力欄・エラー）の後に、ボタンの並び。
// どれも、その要素の属性（role・id など）をそのまま受け取り、class を足せる（窓ごとの並べ方の CSS）。

/** class を足す（部品の class の後ろに、呼ぶ側の class）。 */
const withClass = (base: string, extra: string | undefined): string =>
  extra ? `${base} ${extra}` : base;

/** 本文の塊。見出し・文・入力欄・エラーを入れる。 */
export function CardBody(
  props: JSX.HTMLAttributes<HTMLDivElement>,
): JSX.Element {
  const [own, rest] = splitProps(props, ["class"]);
  return <div {...rest} class={withClass("card-body", own.class)} />;
}

/** 窓の見出し。右下の知らせのように、窓の中の 2 つ目の段の見出しなら level 2。 */
export function CardTitle(
  props: JSX.HTMLAttributes<HTMLHeadingElement> & { level?: 1 | 2 },
): JSX.Element {
  const [own, rest] = splitProps(props, ["class", "level"]);
  return (
    <Dynamic
      component={own.level === 2 ? "h2" : "h1"}
      {...rest}
      class={withClass("card-title", own.class)}
    />
  );
}

/** 本文の文 1 段。 */
export function CardText(
  props: JSX.HTMLAttributes<HTMLParagraphElement>,
): JSX.Element {
  const [own, rest] = splitProps(props, ["class"]);
  return <p {...rest} class={withClass("card-text", own.class)} />;
}

/** できなかった理由。長いエラーも折り返して等幅で出す。 */
export function CardError(
  props: JSX.HTMLAttributes<HTMLPreElement>,
): JSX.Element {
  const [own, rest] = splitProps(props, ["class"]);
  return <pre {...rest} class={withClass("card-error", own.class)} />;
}

/** 下のボタンの並び（Button を右寄せ。主ボタンが右端）。 */
export function CardActions(
  props: JSX.HTMLAttributes<HTMLDivElement>,
): JSX.Element {
  const [own, rest] = splitProps(props, ["class"]);
  return <div {...rest} class={withClass("card-actions", own.class)} />;
}
