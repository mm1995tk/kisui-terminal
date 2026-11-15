// 内蔵ブラウザのタブ（#202）を、画面のどこに重ねるか。DOM も Tauri も使わない（node --test で確かめられる）。
//
// タブのページは子の webview で、kisui-terminal の画面（メインの webview の DOM）より上に重なる。
// そのまま重ねると、右下のお知らせ・リーダーの案内・右クリックのメニュー・ダイアログが隠れてしまう。そこで:
// - ダイアログ（真ん中に出して後ろを触らせないもの）が出ている間は、ページを隠す（答えるまで、ほかの操作は止まるため）。
// - お知らせ・リーダーの案内・メニューなど、ページの場所に重なるものがあれば、ページの下の端をそれの上の端まで上げる
//   （縦だけ縮める。横に縮めると、ページの組み直しで文の折り返しが変わり、読んでいた所を見失うため）。
//   縮めると低くなりすぎる（MIN_HEIGHT より低い）ときは隠す。
// - トースト（倍率・コピーしたこと・ブックマークに足したこと）も、ページを出している間は画面の下の中央に出して避ける
//   （data-overlay。ページを出している間の操作は、ほかに画面が変わらないことがあり、知らせが見えないと効いたか分からないため）。

/** 画面の中の四角（CSS ピクセルか論理ピクセル）。 */
export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 重なるものとページの間に空ける幅。 */
export const OVERLAY_GAP = 8;
/** これより低くなるなら、ページを隠す。 */
export const MIN_HEIGHT = 120;

const overlaps = (a: Bounds, b: Bounds) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * ページを置く四角。隠すなら null。area はページを出す場所（グリッドの場所）、overlays は上に出ているもの、
 * modal はダイアログが出ているか。
 */
export function pageBounds(
  area: Bounds,
  overlays: readonly Bounds[],
  modal: boolean,
): Bounds | null {
  if (modal || area.w <= 0 || area.h <= 0) return null;
  let bottom = area.y + area.h;
  for (const o of overlays) {
    if (o.w <= 0 || o.h <= 0 || !overlaps(area, o)) continue;
    bottom = Math.min(bottom, o.y - OVERLAY_GAP);
  }
  const h = bottom - area.y;
  if (h < Math.min(MIN_HEIGHT, area.h)) return null;
  return { x: area.x, y: area.y, w: area.w, h };
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
