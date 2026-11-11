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
  type Size,
  type View,
} from "./imageView.ts";

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

/** 倍率 1 は、欄に収めた大きさ。 */
export function createImageZoom(o: ImageZoomOptions) {
  const [view, setView] = createSignal<View>(HOME);
  const [dragging, setDragging] = createSignal(false);
  let img: HTMLImageElement | undefined;

  const sizes = (): { base: Size; view: Size } | undefined => {
    if (!img) return undefined;
    const body = o.body();
    // offsetWidth・Height は transform の影響を受けない（収めた大きさ）
    return {
      base: { w: img.offsetWidth, h: img.offsetHeight },
      view: { w: body.clientWidth, h: body.clientHeight },
    };
  };
  const apply = (f: (v: View, s: { base: Size; view: Size }) => View) => {
    const s = sizes();
    if (s) setView((v) => f(v, s));
  };
  /** 本文の中心からの位置（px）。 */
  const fromCenter = (x: number, y: number) => {
    const r = o.body().getBoundingClientRect();
    return { x: x - (r.left + r.width / 2), y: y - (r.top + r.height / 2) };
  };

  createEffect(
    on(
      () => o.url(),
      () => setView(HOME),
    ),
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (!o.enabled()) return;
    const k = imageKey(e);
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
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
        setView(HOME);
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
  };

  onMount(() => {
    if (!o.enabled()) return;
    const body = o.body();
    // Ctrl+ホイール（トラックパッドのピンチもこの形で届く）。ブラウザ自身の拡大を止めるため passive にしない
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
      start = view().scale;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & {
        scale: number;
        clientX?: number;
        clientY?: number;
      };
      const at = fromCenter(g.clientX ?? 0, g.clientY ?? 0);
      apply((v, s) =>
        zoomBy(v, (start * g.scale) / v.scale, at, s.base, s.view),
      );
    };
    body.addEventListener("wheel", onWheel, { passive: false });
    body.addEventListener("gesturestart", onGestureStart);
    body.addEventListener("gesturechange", onGestureChange);
    // 欄の大きさが変わったら、はみ出す範囲に収め直す
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
  });

  // ドラッグで動かす（拡大中）
  let drag: { x: number; y: number } | undefined;
  const onPointerDown = (e: PointerEvent) => {
    if (!o.enabled() || e.button !== 0 || view().scale <= 1) return;
    drag = { x: e.clientX, y: e.clientY };
    setDragging(true);
    o.body().setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    apply((v, s) => dragBy(v, dx, dy, s.base, s.view));
  };
  const onPointerUp = () => {
    drag = undefined;
    setDragging(false);
  };

  return {
    /** 拡大中か */
    zoomed: () => o.enabled() && view().scale > 1,
    dragging,
    /** <img> に当てる transform */
    transform: () => transformOf(view()),
    /** <img> の ref */
    imgRef: (el: HTMLImageElement) => {
      img = el;
    },
    onKeyDown,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}
