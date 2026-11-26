import { T } from "../../../../i18n/index.ts";
import { createEffect, createSignal, on, onCleanup } from "solid-js";

import type { ExtraPane } from "../../../../infrastructure/rpc/protocol.ts";
import { formatBytes } from "../../../../features/file-transfer/transfer.ts";
import {
  fileLabel,
  fileMime,
  loadFile,
  maxBytes,
  tooLarge,
  type MediaFetch,
} from "../../../../features/terminal/media.ts";

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
        const what = fileLabel(p.kind);
        if (tooLarge(p.kind, p.size)) {
          setLoad({
            kind: "error",
            text: T("file.tooLarge", {
              what,
              size: formatBytes(p.size),
              max: formatBytes(maxBytes(p.kind)),
            }),
          });
          return;
        }
        // Blob の type は serve の返事をそのまま使わず、ペインの種類と拡張子から決める（fileMime）。決まらなければ取らない
        const type = fileMime(p.kind, p.path, p.mime);
        if (!type) {
          setLoad({
            kind: "error",
            text: T("file.wrongType", { what, path: p.path }),
          });
          return;
        }
        loadFile(
          read(),
          ac.signal,
          type,
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
              text: T("file.fetchFailed", {
                what,
                reason: e instanceof Error ? e.message : String(e),
              }),
            });
          },
        );
      },
    ),
  );
  return { load, fail: (text) => setLoad({ kind: "error", text }) };
}
