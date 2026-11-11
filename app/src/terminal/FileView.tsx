import {
  createEffect,
  createSignal,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  type JSX,
} from "solid-js";

import type { ExtraPane } from "../rpc/protocol.ts";
import { baseName, FILE_LABEL, type MediaFetch } from "./media.ts";
import { createFileSource } from "./fileSource.ts";
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
import { openKeyList } from "../KeyListDialog.tsx";

/** WebView が PDF を表示できるか（WebKitGTK は偽。古い WebView で値が無いときは表示を試す）。 */
function pdfViewable(): boolean {
  return navigator.pdfViewerEnabled !== false;
}

/** 種類ごとの本文（画像は <img>、PDF は <iframe>）。 */
function Body(props: {
  pane: ExtraPane;
  url: string;
  fail: (text: string) => void;
  imgRef?: (el: HTMLImageElement) => void;
  imgStyle?: JSX.CSSProperties;
}): JSX.Element {
  return (
    <Switch>
      <Match when={props.pane.kind === "pdf"}>
        <Show
          when={pdfViewable()}
          fallback={
            <p class="video-note" role="status">
              この環境の WebView は PDF を表示できません（{props.pane.path}）
            </p>
          }
        >
          <iframe
            src={props.url}
            title={baseName(props.pane.path)}
            class="file-pdf"
          />
        </Show>
      </Match>
      <Match when={true}>
        <img
          ref={(el) => props.imgRef?.(el)}
          style={props.imgStyle}
          draggable={false}
          src={props.url}
          alt={baseName(props.pane.path)}
          onError={() =>
            props.fail("この画像は表示できません（形式に対応していません）")
          }
        />
      </Match>
    </Switch>
  );
}

/**
 * 画像と PDF の欄。動画の欄（VideoView）と同じ升目・同じ見出しで、中身は media.read で取って（fileSource.ts）、
 * 画像は <img>、PDF は WebView の PDF 表示（<iframe>）で出す。種類を足すときは、Body に 1 つ足す。
 * WebView が PDF を表示できない環境（WebKitGTK など）では、iframe に渡さず、欄にその理由を出す。
 */
export function FileView(props: {
  pane: ExtraPane;
  /** 中身を取る関数（欄の id は束ねてある） */
  read: MediaFetch;
  active?: boolean;
  hidden?: boolean;
  /** 欄の位置（分割の木から決めた、親の中の left・top・width・height） */
  place?: Record<string, string>;
  onFocus?: () => void;
  onClose: () => void;
  /** この欄にキーを向ける関数を受け取る（欄が無くなるとき undefined で呼ぶ） */
  focusRef?: (focus: (() => void) | undefined) => void;
  /** 画像の欄で Esc を押した（ターミナルへ戻る） */
  onLeave?: () => void;
}): JSX.Element {
  let cell!: HTMLDivElement;
  let body!: HTMLDivElement;
  let img: HTMLImageElement | undefined;
  const source = createFileSource(
    () => props.pane,
    () => props.read,
  );
  props.focusRef?.(() => cell.focus());
  onCleanup(() => props.focusRef?.(undefined));
  const ready = () => {
    const l = source.load();
    return l.kind === "ready" ? l : undefined;
  };
  const isImage = () => props.pane.kind === "image";

  // 画像の拡大・縮小と、見える場所の移動（imageView.ts）。倍率 1 は、欄に収めた大きさ。
  const [zoom, setZoom] = createSignal<View>(HOME);
  const [dragging, setDragging] = createSignal(false);
  const sizes = (): { base: Size; view: Size } | undefined => {
    if (!img) return undefined;
    // offsetWidth・Height は transform の影響を受けない（収めた大きさ）
    return {
      base: { w: img.offsetWidth, h: img.offsetHeight },
      view: { w: body.clientWidth, h: body.clientHeight },
    };
  };
  const apply = (f: (v: View, s: { base: Size; view: Size }) => View) => {
    const s = sizes();
    if (s) setZoom((v) => f(v, s));
  };
  /** body の中心からの位置（px）。 */
  const fromCenter = (x: number, y: number) => {
    const r = body.getBoundingClientRect();
    return { x: x - (r.left + r.width / 2), y: y - (r.top + r.height / 2) };
  };
  createEffect(
    on(
      () => ready()?.url,
      () => setZoom(HOME),
    ),
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (!isImage()) return;
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
        setZoom(HOME);
        break;
      case "pan":
        apply((v, s) => panBy(v, k.dir, s.base, s.view));
        break;
      case "leave":
        props.onLeave?.();
        break;
      case "help":
        openKeyList();
        break;
    }
  };

  onMount(() => {
    if (!isImage()) return;
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
      start = zoom().scale;
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
    if (!isImage() || e.button !== 0 || zoom().scale <= 1) return;
    drag = { x: e.clientX, y: e.clientY };
    setDragging(true);
    body.setPointerCapture(e.pointerId);
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

  const label = () => FILE_LABEL[props.pane.kind] ?? "ファイル";

  return (
    <div
      class="terminal-cell video-cell"
      data-active={props.active ? "" : undefined}
      hidden={props.hidden}
      style={props.place}
      tabindex="-1"
      ref={cell}
      onFocusIn={() => props.onFocus?.()}
      onKeyDown={onKeyDown}
      onPointerDown={() => props.onFocus?.()}
    >
      <div class="video-head">
        <span class="video-name" title={props.pane.path}>
          {baseName(props.pane.path)}
        </span>
        <button
          type="button"
          class="video-close"
          aria-label={`${label()}の欄を閉じる`}
          title="閉じる"
          onClick={() => props.onClose()}
        >
          ×
        </button>
      </div>
      <div
        class="video-body"
        classList={{
          "image-zoomed": isImage() && zoom().scale > 1,
          "image-dragging": dragging(),
        }}
        ref={body}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <Switch>
          <Match when={ready()}>
            {(l) => (
              <Body
                pane={props.pane}
                url={l().url}
                fail={source.fail}
                imgRef={(el) => (img = el)}
                imgStyle={{ transform: transformOf(zoom()) }}
              />
            )}
          </Match>
          <Match when={source.load()}>
            {(l) => (
              <p class="video-note" role="status">
                {(() => {
                  const v = l();
                  return v.kind === "error"
                    ? v.text
                    : `${label()}を取っています… ${Math.round((v.kind === "loading" ? v.ratio : 1) * 100)}%`;
                })()}
              </p>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  );
}
