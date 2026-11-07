import { createEffect, createSignal, on, onCleanup } from "solid-js";

import type { ExtraPane } from "../rpc/protocol.ts";
import { formatBytes } from "./transfer.ts";
import {
  FILE_LABEL,
  loadFile,
  maxBytes,
  tooLarge,
  type MediaFetch,
} from "./media.ts";

/** ファイル（動画・画像・PDF）の取れ具合。 */
export type Load =
  | { kind: "loading"; ratio: number }
  | { kind: "ready"; url: string }
  | { kind: "error"; text: string };

/**
 * 欄のファイル（動画・画像・PDF）を取って object URL にする（#555）。欄の id が替わったら取り直し、替わる・欄が無くなるときは
 * 中止して URL を手放す。fail は再生に失敗したときに、欄に理由を出すために呼ぶ。
 */
export function createFileSource(
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
        const what = FILE_LABEL[p.kind] ?? "ファイル";
        if (tooLarge(p.kind, p.size)) {
          setLoad({
            kind: "error",
            text: `${what}が大きすぎて開けません（${formatBytes(p.size)}。上限は ${formatBytes(maxBytes(p.kind))}）`,
          });
          return;
        }
        loadFile(
          read(),
          ac.signal,
          (ratio) => setLoad({ kind: "loading", ratio }),
          maxBytes(p.kind),
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
              text: `${what}を取れませんでした：${e instanceof Error ? e.message : e}`,
            });
          },
        );
      },
    ),
  );
  return { load, fail: (text) => setLoad({ kind: "error", text }) };
}
