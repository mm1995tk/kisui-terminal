// 画像の欄の拡大・縮小の状態と、キー・ホイール・ピンチ・ドラッグの受け口（#93）。判定と計算は imageView.ts（DOM に触らない）。
// FileView は、これが返すものを欄に付けるだけにする。

import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js";

import {
  clampView,
  dragBy,
  HOME,
  imageKey,
  KEY_STEP,
  panBy,
  transformOf,
  wheelFactor,
  zoomBy,
  type ImageKey,
  type Size,
  type View,
} from "./imageView.ts";

/** createImageZoom に渡すもの。 */
export interface ImageZoomOptions {
  /** 画像の欄か（PDF の欄では何も受けない） */
  enabled: () => boolean;
  /** 本文（画像を置く枠）。はみ出す範囲と、ポインタの位置の基準 */
  body: () => HTMLElement;
  /** 画像が替わったら（URL が替わったら）倍率と位置を戻す */
  url: () => string | undefined;
  /** Esc（ターミナルへ戻る） */
  onLeave?: () => void;
  /** `?`（キーの一覧） */
  onHelp?: () => void;
}

/** 見える場所を、収めた大きさ（base）と本文の大きさ（view）を渡して動かす関数。 */
type Apply = (f: (v: View, s: { base: Size; view: Size }) => View) => void;

/** 画像のキーの働きを、見える場所の動きにする。zoom・pan のほかは、呼んだ側に任せる。 */
function runKey(
  k: ImageKey,
  apply: Apply,
  reset: () => void,
  o: Pick<ImageZoomOptions, "onLeave" | "onHelp">,
): void {
  switch (k.kind) {
    case "zoom":
      apply((v, s) =>
        zoomBy(
          v,
          k.dir === "in" ? KEY_STEP : 1 / KEY_STEP,
          { x: 0, y: 0 },
          s.base,
          s.view,
        ),
      );
      break;
    case "reset":
      reset();
      break;
    case "pan":
      apply((v, s) => panBy(v, k.dir, s.base, s.view));
      break;
    case "leave":
      o.onLeave?.();
      break;
    case "help":
      o.onHelp?.();
      break;
  }
}

/**
 * 本文にホイールとピンチを付け、欄の大きさが変わったら収め直す。外すのは onCleanup。
 * ブラウザ自身の拡大を止めるため、wheel は passive にしない。
 */
function watchBody(
  body: HTMLElement,
  apply: Apply,
  scale: () => number,
  fromCenter: (x: number, y: number) => { x: number; y: number },
): void {
  // Ctrl+ホイール（トラックパッドのピンチもこの形で届く）
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const at = fromCenter(e.clientX, e.clientY);
    apply((v, s) =>
      zoomBy(v, wheelFactor(e.deltaY, e.deltaMode), at, s.base, s.view),
    );
  };
  // WKWebView（macOS）のピンチは、wheel でなく gesture イベントで届く
  let start = 1;
  const onGestureStart = (e: Event) => {
    e.preventDefault();
    start = scale();
  };
  const onGestureChange = (e: Event) => {
    e.preventDefault();
    const g = e as Event & {
      scale: number;
      clientX?: number;
      clientY?: number;
    };
    const at = fromCenter(g.clientX ?? 0, g.clientY ?? 0);
    apply((v, s) => zoomBy(v, (start * g.scale) / v.scale, at, s.base, s.view));
  };
  body.addEventListener("wheel", onWheel, { passive: false });
  body.addEventListener("gesturestart", onGestureStart);
  body.addEventListener("gesturechange", onGestureChange);
  const ro = new ResizeObserver(() =>
    apply((v, s) => clampView(v, s.base, s.view)),
  );
  ro.observe(body);
  onCleanup(() => {
    body.removeEventListener("wheel", onWheel);
    body.removeEventListener("gesturestart", onGestureStart);
    body.removeEventListener("gesturechange", onGestureChange);
    ro.disconnect();
  });
}

/** ドラッグで画像を動かす（拡大中だけ）。 */
function createDrag(
  o: Pick<ImageZoomOptions, "enabled" | "body">,
  apply: Apply,
  zoomed: () => boolean,
) {
  const [dragging, setDragging] = createSignal(false);
  let last: { x: number; y: number } | undefined;
  return {
    dragging,
    onPointerDown: (e: PointerEvent) => {
      if (!o.enabled() || e.button !== 0 || !zoomed()) return;
      last = { x: e.clientX, y: e.clientY };
      setDragging(true);
      o.body().setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    onPointerMove: (e: PointerEvent) => {
      if (!last) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      apply((v, s) => dragBy(v, dx, dy, s.base, s.view));
    },
    onPointerUp: () => {
      last = undefined;
      setDragging(false);
    },
  };
}

/** 倍率 1 は、欄に収めた大きさ。 */
export function createImageZoom(o: ImageZoomOptions) {
  const [view, setView] = createSignal<View>(HOME);
  let img: HTMLImageElement | undefined;

  const apply: Apply = (f) => {
    if (!img) return;
    const body = o.body();
    // offsetWidth・Height は transform の影響を受けない（収めた大きさ）
    const s = {
      base: { w: img.offsetWidth, h: img.offsetHeight },
      view: { w: body.clientWidth, h: body.clientHeight },
    };
    setView((v) => f(v, s));
  };
  /** 本文の中心からの位置（px）。 */
  const fromCenter = (x: number, y: number) => {
    const r = o.body().getBoundingClientRect();
    return { x: x - (r.left + r.width / 2), y: y - (r.top + r.height / 2) };
  };
  const zoomed = () => o.enabled() && view().scale > 1;

  createEffect(
    on(
      () => o.url(),
      () => setView(HOME),
    ),
  );
  onMount(() => {
    if (o.enabled()) watchBody(o.body(), apply, () => view().scale, fromCenter);
  });
  const drag = createDrag(o, apply, zoomed);

  return {
    /** 拡大中か */
    zoomed,
    dragging: drag.dragging,
    /** <img> に当てる transform */
    transform: () => transformOf(view()),
    /** <img> の ref */
    imgRef: (el: HTMLImageElement) => {
      img = el;
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (!o.enabled()) return;
      const k = imageKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopPropagation();
      runKey(k, apply, () => setView(HOME), o);
    },
    onPointerDown: drag.onPointerDown,
    onPointerMove: drag.onPointerMove,
    onPointerUp: drag.onPointerUp,
  };
}
