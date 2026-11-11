import { Match, onCleanup, Show, Switch, type JSX } from "solid-js";

import type { ExtraPane } from "../rpc/protocol.ts";
import { baseName, FILE_LABEL, type MediaFetch } from "./media.ts";
import { createFileSource } from "./fileSource.ts";
import { createImageZoom } from "./imageZoom.ts";
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
  const zoom = createImageZoom({
    enabled: () => props.pane.kind === "image",
    body: () => body,
    url: () => ready()?.url,
    onLeave: () => props.onLeave?.(),
    onHelp: () => openKeyList(),
  });

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
      onKeyDown={zoom.onKeyDown}
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
          "image-zoomed": zoom.zoomed(),
          "image-dragging": zoom.dragging(),
        }}
        ref={body}
        onPointerDown={zoom.onPointerDown}
        onPointerMove={zoom.onPointerMove}
        onPointerUp={zoom.onPointerUp}
        onPointerCancel={zoom.onPointerUp}
      >
        <Switch>
          <Match when={ready()}>
            {(l) => (
              <Body
                pane={props.pane}
                url={l().url}
                fail={source.fail}
                imgRef={zoom.imgRef}
                imgStyle={{ transform: zoom.transform() }}
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
