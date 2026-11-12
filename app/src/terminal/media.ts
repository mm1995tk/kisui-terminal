// 動画・画像・PDF の欄の中身を取る（#555）。設計書 docs/design/gui-protocol.md の「ターミナルでない欄」。
//
// ssh の向こうにある動画も、shj との同じ接続の上で media.read を繰り返して取る（1 回で 4 MiB まで）。
// WebView の <video> に範囲を指して渡す道（Tauri の独自のスキーム）は無いので、全部取って Blob にして渡す。
// 取る前に大きさを見て、種類ごとの上限（MAX_BYTES）を超えるものは取らない（WebView のメモリを使い切らないため）。

import type { Requests } from "../rpc/protocol.ts";

type MediaRead = Requests["media.read"];

/** base64 をバイト列にする。 */
function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** media.read を送る関数（欄の id はもう束ねてある）。 */
export type MediaFetch = (
  params: Pick<MediaRead["params"], "offset">,
) => Promise<MediaRead["result"]>;

/** server/filekind.go の fileKinds の maxSize と同じ値にする（片方だけ変えない）。 */
/** 取って開くファイルの大きさの上限（バイト）。種類（ExtraPane.kind）ごと。種類を足すときはここにも足す。 */
export const MAX_BYTES: Record<string, number> = {
  video: 512 * 1024 * 1024,
  image: 64 * 1024 * 1024,
  pdf: 128 * 1024 * 1024,
};

/** 動画の上限（バイト）。 */
export const MAX_VIDEO_BYTES = MAX_BYTES.video!;

/** 欄の見出しや失敗の理由に出す、種類の呼び名。 */
export const FILE_LABEL: Record<string, string> = {
  video: "動画",
  image: "画像",
  pdf: "PDF",
};

/** kind のファイルの上限（バイト）。 */
export function maxBytes(kind: string): number {
  return MAX_BYTES[kind] ?? MAX_VIDEO_BYTES;
}

/** size バイトの kind のファイルを取るのを断るか。 */
export function tooLarge(kind: string, size: number): boolean {
  return size > maxBytes(kind);
}

/**
 * ファイルを eof まで分けて取り、1 つの Blob にする。max は取るのを断る大きさ。progress は取れた割合（0〜1）。signal が中止されたら
 * AbortError で終わる（欄を閉じた・別の動画に替わった）。ファイルが途中で縮んで進まなくなったら、そこで打ち切る。
 */
export async function loadFile(
  read: MediaFetch,
  signal: AbortSignal,
  progress: (ratio: number) => void = () => {},
  max: number = MAX_VIDEO_BYTES,
): Promise<Blob> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  let mime = "application/octet-stream";
  for (;;) {
    signal.throwIfAborted();
    const r = await read(offset === 0 ? {} : { offset });
    signal.throwIfAborted();
    if (r.size > max) throw new Error(`file too large: ${r.size}`);
    const part = decodeBase64(r.data) as Uint8Array<ArrayBuffer>;
    mime = r.mime || mime;
    parts.push(part);
    offset += part.length;
    progress(r.size > 0 ? Math.min(1, offset / r.size) : 1);
    if (r.eof || offset >= r.size) break;
    if (part.length === 0) throw new Error("empty chunk");
  }
  return new Blob(parts, { type: mime });
}

/** パスの最後の名前（欄の見出し）。 */
export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? path : path.slice(i + 1);
}

/** 再生位置を dt 秒動かした先（0 から長さまで）。 */
export function seekTo(current: number, dt: number, duration: number): number {
  const end = Number.isFinite(duration) ? duration : Infinity;
  return Math.min(Math.max(0, current + dt), end);
}

/** <video> に向けたキーの働き。空白と k は再生と停止、左右は 5 秒、j と l は 10 秒、m は消音、? はキーの一覧。 */
export type VideoKey =
  | { kind: "toggle" }
  | { kind: "seek"; dt: number }
  | { kind: "mute" }
  | { kind: "help" };

/** Ctrl・Alt・Meta を押していないキー k を、動画の操作にする。当てはまらなければ null（GUI のキーや、ブラウザの動きに回す）。 */
export function videoKey(e: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): VideoKey | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  switch (e.key) {
    case " ":
    case "k":
      return { kind: "toggle" };
    case "ArrowLeft":
      return e.shiftKey ? null : { kind: "seek", dt: -5 };
    case "ArrowRight":
      return e.shiftKey ? null : { kind: "seek", dt: 5 };
    case "j":
      return { kind: "seek", dt: -10 };
    case "l":
      return { kind: "seek", dt: 10 };
    case "m":
      return { kind: "mute" };
    case "?":
      return { kind: "help" };
    default:
      return null;
  }
}
