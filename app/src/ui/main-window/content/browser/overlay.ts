// 内蔵ブラウザのタブ（#202）を、画面のどこに重ねるか。DOM も Tauri も使わない（node --test で確かめられる）。
//
// タブのページは子の webview で、kisui-terminal の画面（メインの webview の DOM）より上に重なる。
// そのまま重ねると、右下のお知らせ・リーダーの案内・右クリックのメニュー・ダイアログが隠れてしまう。そこで:
// - ダイアログ（真ん中に出して後ろを触らせないもの）が出ている間は、ページを隠す（答えるまで、ほかの操作は止まるため）。
// - ほかの重なるものは、自分に印（OVERLAY_SELECTORS の属性）を付けて、避け方を決める。BrowserArea.tsx は印だけを見る
//   （物の種類ごとのクラス名では選ばない。避け方の振り分けを 1 か所にそろえるため。#439）。
//   - 浮かべるもの（data-overlay。右下のお知らせ・リーダーの案内とキャラクター・右クリックのメニュー）：macOS では
//     ページを縮めず、画面をページより前に出して、ページの上に重ねる（BrowserArea.tsx の floatsOver。ページはすりガラス越しに
//     見え、重なっている間は操作できない。お知らせは閉じるまで残るので、閉じるまでページを操作できない。#439）。
//     ほかの OS は、縮めるもの（下）と同じに避ける。
//   - 縮めるもの（data-overlay-shrink。ページ内検索の欄・トースト）：ページの下の端をそれの上の端まで上げる
//     （縦だけ縮める。横に縮めると、ページの組み直しで文の折り返しが変わり、読んでいた所を見失うため）。
//     縮めると低くなりすぎる（MIN_HEIGHT より低い）ときは隠す。重ねない理由は、ページ内検索はページを見ながら打つため、
//     トーストは倍率などの変化をページで見せるため（ページを出している間は、画面の下の中央に出す）。
//   - 上の端のもの（data-overlay-top。URL バー。#232）：ページの上の端を下げる。

import type { Bounds } from "../../../../features/browser/os.ts";

export type { Bounds };

/** 重なるものが自分に付ける印（属性）。BrowserArea.tsx は、この印でだけ重なるものを探す。 */
export const OVERLAY_SELECTORS = {
  /** ページの上に浮かべる（macOS は縮めずに重ねる。ほかの OS は縮める） */
  float: "[data-overlay]",
  /** ページの下の端を上げて避ける */
  shrink: "[data-overlay-shrink]",
  /** ページの上の端を下げる */
  top: "[data-overlay-top]",
} as const;

/** 重なるものとページの間に空ける幅。 */
export const OVERLAY_GAP = 8;
/** これより低くなるなら、ページを隠す。 */
export const MIN_HEIGHT = 120;

const overlaps = (a: Bounds, b: Bounds) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * ページを置く四角。隠すなら null。area はページを出す場所（グリッドの場所）、overlays は上に出ているもの、
 * modal はダイアログが出ているか。top はページの上の端を下げる高さ（上の端の URL バー。#232）。
 */
export function pageBounds(
  area: Bounds,
  overlays: readonly Bounds[],
  modal: boolean,
  top = 0,
): Bounds | null {
  if (modal || area.w <= 0 || area.h <= 0) return null;
  let bottom = area.y + area.h;
  for (const o of overlays) {
    if (o.w <= 0 || o.h <= 0 || !overlaps(area, o)) continue;
    bottom = Math.min(bottom, o.y - OVERLAY_GAP);
  }
  const y = area.y + Math.max(0, top);
  const h = bottom - y;
  if (h < Math.min(MIN_HEIGHT, area.h)) return null;
  return { x: area.x, y, w: area.w, h };
}

/** CSS ピクセルの四角を、窓の論理ピクセルにする（画面全体の大きさ zoom を掛ける）。端は整数に丸める。 */
export function toLogical(b: Bounds, zoom: number): Bounds {
  const x = Math.round(b.x * zoom);
  const y = Math.round(b.y * zoom);
  return {
    x,
    y,
    w: Math.round((b.x + b.w) * zoom) - x,
    h: Math.round((b.y + b.h) * zoom) - y,
  };
}

/** 同じ四角か（変わったときだけ殻に送る）。 */
export function sameBounds(a: Bounds | null, b: Bounds | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * ページの上に浮かべる（縮めずに、ページの上に重ねる）ものが、ページを出す場所に重なっているか。
 * 重なっていれば、画面（メインの webview）をページより前に出し、ページはすりガラス越しに見せる（BrowserArea.tsx）。
 */
export function floatsOver(area: Bounds, floats: readonly Bounds[]): boolean {
  return floats.some((o) => o.w > 0 && o.h > 0 && overlaps(area, o));
}

/**
 * ページにキーを向けてよいか。浮かべるものがページに重なっている間と、リーダーに入っている間は向けない。
 * リーダーの途中でページにキーを向けると、画面（メインの webview）がキーを失い、リーダーが閉じる（#256）。
 */
export function mayFocusPage(floating: boolean, leaderOpen: boolean): boolean {
  return !floating && !leaderOpen;
}
