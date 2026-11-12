import { createEffect, Match, onCleanup, Switch, type JSX } from "solid-js";

import { openKeyList } from "../KeyListDialog.tsx";
import type { ExtraPane } from "../rpc/protocol.ts";
import { baseName, seekTo, videoKey, type MediaFetch } from "./media.ts";
import { createFileSource } from "./fileSource.ts";

/**
 * 動画のペイン（#555）。ターミナルのペインと同じ升目に並ぶ（TerminalGrid）。shj が頼んだ動画を media.read で取って
 * <video> で再生する（取るのは fileSource.ts）。見出しの × で閉じる。キーは、このペインにキーが向いているときだけ
 * 受ける：空白と k は再生・停止、← → は 5 秒、j l は 10 秒、m は消音。GUI のショートカット
 * （リーダー・Cmd+D など）はここで止めず、いつも通り GUI が受ける。隠したら止める（音が鳴り続けないように。戻しても再開しない）。
 */
export function VideoView(props: {
  pane: ExtraPane;
  /** 中身を取る関数（ペインの id は束ねてある） */
  read: MediaFetch;
  /** 今キーを向けているペインか（並べたときに印を付ける） */
  active?: boolean;
  /** 隠すか（ほかのペインを隠しているとき） */
  hidden?: boolean;
  /** ペインの位置（分割の木から決めた、親の中の left・top・width・height） */
  place?: Record<string, string>;
  /** ペインがフォーカスを受けた */
  onFocus?: () => void;
  onClose: () => void;
  /** このペインにキーを向ける関数を受け取る（ペインが無くなるとき undefined で呼ぶ） */
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
    if (e.isComposing) return;
    const k = videoKey(e);
    if (!k) return;
    // キーの一覧は、動画を取っている間でも出す
    if (k.kind === "help") {
      e.preventDefault();
      e.stopPropagation();
      openKeyList("video");
      return;
    }
    if (!video) return;
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
      style={props.place}
      tabindex="-1"
      data-place="video"
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
          aria-label="動画のペインを閉じる"
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
