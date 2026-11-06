import { createEffect, createSignal, on, onCleanup } from "solid-js";

import type { ExtraPane } from "../rpc/protocol.ts";
import { formatBytes } from "./transfer.ts";
import {
  loadVideo,
  MAX_VIDEO_BYTES,
  tooLarge,
  type MediaFetch,
} from "./media.ts";

/** 動画の取れ具合。 */
export type Load =
  | { kind: "loading"; ratio: number }
  | { kind: "ready"; url: string }
  | { kind: "error"; text: string };

/**
 * 欄の動画を取って object URL にする（#555）。欄の id が替わったら取り直し、替わる・欄が無くなるときは
 * 中止して URL を手放す。fail は再生に失敗したときに、欄に理由を出すために呼ぶ。
 */
export function createVideoSource(
  pane: () => ExtraPane,
  read: () => MediaFetch,
): { load: () => Load; fail: (text: string) => void } {
  const [load, setLoad] = createSignal<Load>({ kind: "loading", ratio: 0 });
  createEffect(
    on(
      () => pane().id,
      () => {
        const p = pane();
        const ac = new AbortController();
        let url: string | undefined;
        setLoad({ kind: "loading", ratio: 0 });
        onCleanup(() => {
          ac.abort();
          if (url) URL.revokeObjectURL(url);
        });
        if (tooLarge(p.size)) {
          setLoad({
            kind: "error",
            text: `動画が大きすぎて開けません（${formatBytes(p.size)}。上限は ${formatBytes(MAX_VIDEO_BYTES)}）`,
          });
          return;
        }
        loadVideo(read(), ac.signal, (ratio) =>
          setLoad({ kind: "loading", ratio }),
        ).then(
          (blob) => {
            if (ac.signal.aborted) return;
            url = URL.createObjectURL(blob);
            setLoad({ kind: "ready", url });
          },
          (e) => {
            if (ac.signal.aborted) return;
            setLoad({
              kind: "error",
              text: `動画を取れませんでした：${e instanceof Error ? e.message : e}`,
            });
          },
        );
      },
    ),
  );
  return { load, fail: (text) => setLoad({ kind: "error", text }) };
}
