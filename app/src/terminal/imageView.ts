// 画像のペインの拡大・縮小と、見える場所の移動（#93）。docs/key-design.md の 5 章の「画像のペイン」のキー。
// DOM には触らない（node --test で確かめられる）。表示は、ペインに収めた大きさ（倍率 1）に、倍率と平行移動を CSS の transform で重ねる。
//
// 場所のキーなので、リーダーの木（commands.ts）には載せない。ここに足せば、受ける判定（imageKey）と
// `?` の一覧（IMAGE_KEY_ROWS）が同じ表から出る。

import type { KeyLike } from "../guiKeys.ts";

/** 倍率の下限と上限（ペインに収めた大きさを 1 とする）。 */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 16;
/** キーで 1 回押すと変わる倍率（1.25 倍）。 */
export const KEY_STEP = 1.25;
/** 矢印・h j k l で 1 回に動かす幅（見える範囲に対する割合）。 */
export const PAN_STEP = 0.1;

export type Dir = "left" | "right" | "up" | "down";

/** 画像のペインのキーの働き。pan は、見える場所を動かす向き。 */
export type ImageKey =
  | { kind: "zoom"; dir: "in" | "out" }
  | { kind: "reset" }
  | { kind: "pan"; dir: Dir }
  | { kind: "leave" }
  | { kind: "help" };

/** `?` の一覧に出す行。 */
export const IMAGE_KEY_ROWS: readonly { keys: string; label: string }[] = [
  { keys: "+ =", label: "拡大する" },
  { keys: "-", label: "縮小する" },
  { keys: "0", label: "ペインに収まる大きさに戻す" },
  { keys: "h j k l / ← ↓ ↑ →", label: "拡大中に、見える場所を動かす" },
  { keys: "Esc", label: "ターミナルへ戻る" },
  { keys: "?", label: "このキーの一覧を出す" },
];

const ARROWS: Record<string, Dir> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};
const VIM: Record<string, Dir> = {
  h: "left",
  l: "right",
  k: "up",
  j: "down",
};

/**
 * 画像のペインにフォーカスがあるときのキー e の働き。当てはまらなければ null（GUI のキーや、ブラウザの動きに回す）。
 * Ctrl・Alt・Meta を押していれば null。全体の倍率の Cmd+=・Ctrl+= などは、ここまで来ずに GUI が先に受ける。
 */
export function imageKey(e: KeyLike): ImageKey | null {
  if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return null;
  switch (e.key) {
    case "+":
    case "=":
      return { kind: "zoom", dir: "in" };
    case "-":
      return { kind: "zoom", dir: "out" };
    case "0":
      return e.shiftKey ? null : { kind: "reset" };
    case "Escape":
      return e.shiftKey ? null : { kind: "leave" };
    case "?":
      return { kind: "help" };
  }
  const arrow = ARROWS[e.key];
  if (arrow) return e.shiftKey ? null : { kind: "pan", dir: arrow };
  const vim = VIM[e.key];
  return vim ? { kind: "pan", dir: vim } : null;
}

export interface Size {
  w: number;
  h: number;
}

/** 見える場所の動き。x・y は、画像の中心がペインの中心から離れた幅（px）。 */
export interface View {
  scale: number;
  x: number;
  y: number;
}

export const HOME: View = { scale: 1, x: 0, y: 0 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** 倍率を範囲に収める。1 に近いときは 1 にそろえる（拡大して縮小したとき、ずれが残らないように）。 */
export function clampScale(s: number): number {
  const c = clamp(s, MIN_SCALE, MAX_SCALE);
  return Math.abs(c - 1) < 1e-6 ? 1 : c;
}

/**
 * 画像がペインからはみ出す分だけ動かせる。はみ出さない向きは中央に置く。
 * base はペインに収めたときの画像の大きさ、view はペインの本文の大きさ。
 */
export function clampView(v: View, base: Size, view: Size): View {
  const scale = clampScale(v.scale);
  const lim = (img: number, box: number) =>
    Math.max(0, (img * scale - box) / 2);
  const mx = lim(base.w, view.w);
  const my = lim(base.h, view.h);
  // + 0 は -0 を 0 にする
  return { scale, x: clamp(v.x, -mx, mx) + 0, y: clamp(v.y, -my, my) + 0 };
}

/**
 * 倍率を factor 倍にする。at は、動かさない点（ペインの中心からの px。マウスの位置。キーなら中心 {0,0}）。
 */
export function zoomBy(
  v: View,
  factor: number,
  at: { x: number; y: number },
  base: Size,
  view: Size,
): View {
  const scale = clampScale(v.scale * factor);
  const r = scale / v.scale;
  return clampView(
    { scale, x: at.x - r * (at.x - v.x), y: at.y - r * (at.y - v.y) },
    base,
    view,
  );
}

/** 見える場所を dir へ 1 歩動かす（画像は逆向きに動く）。 */
export function panBy(v: View, dir: Dir, base: Size, view: Size): View {
  const dx = dir === "left" ? -1 : dir === "right" ? 1 : 0;
  const dy = dir === "up" ? -1 : dir === "down" ? 1 : 0;
  return clampView(
    {
      scale: v.scale,
      x: v.x - dx * view.w * PAN_STEP,
      y: v.y - dy * view.h * PAN_STEP,
    },
    base,
    view,
  );
}

/** ドラッグで dx・dy（px）だけ画像を動かす。 */
export function dragBy(
  v: View,
  dx: number,
  dy: number,
  base: Size,
  view: Size,
): View {
  return clampView({ scale: v.scale, x: v.x + dx, y: v.y + dy }, base, view);
}

/** Ctrl+ホイール（ピンチもこの形で届く）の deltaY から、倍率の掛け目。上へ回す（deltaY < 0）と拡大。 */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const px =
    deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-clamp(px, -200, 200) * 0.01);
}

/** 画像に当てる CSS の transform。 */
export function transformOf(v: View): string {
  return `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
}
