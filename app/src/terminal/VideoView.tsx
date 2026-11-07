import { createEffect, Match, onCleanup, Switch, type JSX } from "solid-js";

import type { ExtraPane } from "../rpc/protocol.ts";
import { baseName, seekTo, videoKey, type MediaFetch } from "./media.ts";
import { createFileSource } from "./fileSource.ts";

/**
 * 動画の欄（#555）。ターミナルの欄と同じ升目に並ぶ（TerminalGrid）。shj が頼んだ動画を media.read で取って
 * <video> で再生する（取るのは fileSource.ts）。見出しの × で閉じる。キーは、この欄にキーが向いているときだけ
 * 受ける：空白と k は再生・停止、← → は 5 秒、j l は 10 秒、m は消音。GUI のショートカット
 * （Ctrl+Shift+矢印など）はここで止めず、いつも通り GUI が受ける。隠したら止める（音が鳴り続けないように。戻しても再開しない）。
 */
export function VideoView(props: {
  pane: ExtraPane;
  /** 中身を取る関数（欄の id は束ねてある） */
  read: MediaFetch;
  /** 今キーを向けている欄か（並べたときに印を付ける） */
  active?: boolean;
  /** 隠すか（ほかの欄を隠しているとき） */
  hidden?: boolean;
  /** 欄の位置（CSS grid の grid-area） */
  area?: string;
  /** 欄がフォーカスを受けた */
  onFocus?: () => void;
  onClose: () => void;
  /** この欄にキーを向ける関数を受け取る（欄が無くなるとき undefined で呼ぶ） */
  focusRef?: (focus: (() => void) | undefined) => void;
}): JSX.Element {
  let cell!: HTMLDivElement;
  let video: HTMLVideoElement | undefined;
  const source = createFileSource(
    () => props.pane,
    () => props.read,
  );

  const focus = () => (video ?? cell).focus();
  props.focusRef?.(focus);
  onCleanup(() => props.focusRef?.(undefined));

  createEffect(() => {
    if (props.hidden) video?.pause();
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || !video) return;
    const k = videoKey(e);
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    if (k.kind === "toggle") void (video.paused ? video.play() : video.pause());
    else if (k.kind === "mute") video.muted = !video.muted;
    else video.currentTime = seekTo(video.currentTime, k.dt, video.duration);
  };

  return (
    <div
      class="terminal-cell video-cell"
      data-active={props.active ? "" : undefined}
      hidden={props.hidden}
      style={props.area ? { "grid-area": props.area } : undefined}
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
          aria-label="動画の欄を閉じる"
          title="閉じる"
          onClick={() => props.onClose()}
        >
          ×
        </button>
      </div>
      <div class="video-body">
        <Switch>
          <Match when={source.load().kind === "ready" && source.load()}>
            {(l) => (
              <video
                ref={(el) => {
                  video = el;
                  onCleanup(() => {
                    if (video === el) video = undefined;
                  });
                }}
                src={(l() as { url: string }).url}
                controls
                autoplay
                playsinline
                tabindex="0"
                onError={() =>
                  source.fail(
                    "この動画は再生できません（形式に対応していません）",
                  )
                }
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
                    : `動画を取っています… ${Math.round((v.kind === "loading" ? v.ratio : 1) * 100)}%`;
                })()}
              </p>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  );
}
