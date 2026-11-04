// 画像・プレビューの画像・差分の変更のバーを描く部品（E6）。画像の実体は blob.ts で blob.get から取る。
// 置き場所は shj が決める（プレビューの画像は表示行、画像のペインは説明の行の下の全部）。ここでは決められた
// 枠に、画像を縦横比を保って縮めて入れるだけ（大きくはしない。TUI の core.FitImage と同じ）。

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  on,
  onCleanup,
  Show,
  untrack,
  type JSX,
} from "solid-js";

import type {
  DiffInfo,
  ImageRef,
  PreviewImage,
  Theme,
} from "../rpc/protocol.ts";
import { blobKey, type BlobSource } from "./blob.ts";
import { barColor, changeBar } from "./diff.ts";
import { LINE_HEIGHT } from "./layout.ts";
import { colorOf } from "./theme.ts";

/** blob.get で取った画像。取れるまでと、取れなかったときは何も出さない。 */
export function BlobImg(props: {
  image: ImageRef;
  blobs?: BlobSource;
  class?: string;
}): JSX.Element {
  const key = createMemo(() =>
    props.blobs ? `${props.blobs.id}\u0000${blobKey(props.image)}` : "",
  );
  const [src, setSrc] = createSignal<string>();
  createEffect(
    on(key, (k) => {
      setSrc(undefined);
      if (!k) return;
      const { blobs, image } = untrack(() => ({
        blobs: props.blobs!,
        image: props.image,
      }));
      let live = true;
      onCleanup(() => (live = false));
      blobs.url(image).then(
        (u) => live && setSrc(u),
        (e) => live && console.warn(`blob ${image.blob}:`, e),
      );
    }),
  );
  return (
    <Show when={src()}>
      {(u) => (
        <img
          class={props.class}
          src={u()}
          alt=""
          draggable={false}
          width={props.image.width}
          height={props.image.height}
        />
      )}
    </Show>
  );
}

/**
 * プレビュー（とレビューカード）の行の上に重ねる画像。top は 1 行目の表示行、left は左に空ける桁、
 * cols は使える桁数。画像の表示行の範囲の行は空なので、その上に置く。
 * スクロールのたびに images は新しいオブジェクトで届くので、位置で使い回す（同じ画像なら BlobImg は
 * 鍵が変わらず、<img> を作り直さない）。
 */
export function PreviewImages(props: {
  images: readonly PreviewImage[] | null | undefined;
  top: number;
  cols: number;
  left?: number;
  blobs?: BlobSource;
}): JSX.Element {
  return (
    <Index each={props.images ?? []}>
      {(im) => (
        <div
          class="files-preview-image"
          style={{
            top: `${(im().row - props.top) * LINE_HEIGHT}px`,
            left: `${(props.left ?? 0) + (im().col ?? 0)}ch`,
            width: `${Math.max(1, props.cols - (im().col ?? 0))}ch`,
            height: `${im().rows * LINE_HEIGHT}px`,
          }}
        >
          <BlobImg image={im().image} blobs={props.blobs} />
        </div>
      )}
    </Index>
  );
}

/** 画像のペインの本文。説明の行の下の全部に、画像を真ん中に置く。 */
export function ImageBody(props: {
  caption?: string;
  image?: ImageRef | null;
  rows: number;
  blobs?: BlobSource;
}): JSX.Element {
  return (
    <>
      <div class="files-caption">{props.caption ?? ""}</div>
      <div
        class="files-image"
        style={{ height: `${Math.max(0, props.rows - 1) * LINE_HEIGHT}px` }}
      >
        <Show when={props.image}>
          {(im) => <BlobImg image={im()} blobs={props.blobs} />}
        </Show>
      </div>
    </>
  );
}

/** 差分のペインの右端の変更のバー。rows はペインの行数。 */
export function ChangeBar(props: {
  diff: DiffInfo;
  rows: number;
  theme: Theme | null;
}): JSX.Element {
  const cells = createMemo(() => changeBar(props.diff, props.rows));
  return (
    <div class="files-diff-bar" aria-hidden="true">
      <For each={cells()}>
        {(c) => (
          <div
            class="files-diff-bar-cell"
            style={{
              background: c.view
                ? colorOf(props.theme, "diff.bar.view")
                : undefined,
            }}
          >
            <Show when={c.kind}>
              <span
                class="files-diff-bar-mark"
                style={{ background: colorOf(props.theme, barColor(c.kind)) }}
              />
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
