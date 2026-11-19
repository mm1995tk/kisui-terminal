// 帯とタブの行が共に使う小さな部品（絵の字・つかむ所・切れた名前のツールチップ）。
import type { JSX } from "solid-js";

/**
 * 切れているときだけ、その部分の全文を title に出す。切れていなければ title を外し、帯のフルパス（親の title）を出す。
 * 切れているかは、マウスが乗った時に調べる（幅はサイドバーを動かすと変わるので、描いた時には決めない）。
 */
export function titleIfClipped(
  full: string,
): JSX.HTMLAttributes<HTMLSpanElement> {
  return {
    onMouseEnter: (e) => {
      const el = e.currentTarget;
      if (el.scrollWidth > el.clientWidth) el.title = full;
      else el.removeAttribute("title");
    },
  };
}

/** 絵の字（Nerd Fonts）。読み上げには出さない。 */
export function Nf(props: { c: string; class?: string }): JSX.Element {
  return (
    <span class={`nf ${props.class ?? ""}`} aria-hidden="true">
      {props.c}
    </span>
  );
}

/**
 * タブの行の左端の、つかむ所（縦の点 3 つ）。ドラッグ（drag.ts）はここからだけ始める。
 * 行のボタンはここに無いので、行の押下とは取り合わない。スクロールも、ここを押したときは始めさせない（CSS の touch-action）。
 * onGrab を渡さなければ、場所と見た目だけ（動かせない）。ドラッグは場所を指す操作なので、読み上げには出さない（タブの行にはキーが無い）。
 */
export function Grip(props: {
  onGrab?: (e: PointerEvent) => void;
}): JSX.Element {
  return (
    <span
      class="grip"
      data-grab={props.onGrab ? "" : undefined}
      aria-hidden="true"
      onPointerDown={(e) => props.onGrab?.(e)}
    />
  );
}
