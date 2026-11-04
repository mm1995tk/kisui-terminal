// 画像の実体を blob.get で取り、<img> に渡せる URL にする（E6）。設計書 docs/design/gui-protocol.md の
// 3 章 blob.get：画像は Screen に埋め込まず ImageRef で持ち、これで取る。1 回で返るのは 4 MiB までなので、
// eof まで offset をずらして分けて取る。
//
// - 1 つのつなぎ先（マシン）に 1 つ持つ。同じ画像は 1 回だけ取る（取っている最中の要求も分け合う）。
// - 覚えておくのは新しく使った順に max 個まで。あふれたものは URL を手放す。
// - 取れなかったもの（画面から消えた画像は shj が not_found を返す）は覚えない（次に出たときに取り直す）。

import type { ImageRef, Requests } from "../rpc/protocol.ts";

type BlobGet = Requests["blob.get"];

/** blob.get を送る関数。 */
export type BlobFetch = (
  params: BlobGet["params"],
) => Promise<BlobGet["result"]>;

/** ファイルの欄が画像の URL を求める先。 */
export interface BlobSource {
  /** つなぎ先ごとに違う値（別のマシンの同じパスの画像を取り違えないように） */
  readonly id: number;
  /** ref の画像の URL。取れなければ reject する */
  url(ref: ImageRef): Promise<string>;
}

/** 覚えておく画像の数の既定 */
export const DEFAULT_MAX_BLOBS = 64;

/**
 * 同じ画像とみなす鍵。blob（ファイルのパスか mermaid の図の鍵）に、大きさと容量を足す
 * （ファイルが書き換わったら取り直すように）。
 */
export function blobKey(ref: ImageRef): string {
  return `${ref.blob}\u0000${ref.width}x${ref.height}\u0000${ref.size ?? ""}`;
}

/** base64 をバイト列にする。 */
export function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** id の blob を eof まで分けて取り、つないだバイト列と MIME を返す。 */
export async function fetchBlob(
  get: BlobFetch,
  id: string,
): Promise<{ mime: string; bytes: Uint8Array }> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let mime = "";
  for (;;) {
    const r = await get(offset === 0 ? { id } : { id, offset });
    const part = decodeBase64(r.data);
    mime = r.mime;
    parts.push(part);
    offset += part.length;
    if (r.eof || offset >= r.size) break;
    // 進まないなら打ち切る（shj が壊れた返事をしても回り続けないように）
    if (part.length === 0) throw new Error(`blob ${id}: empty chunk`);
  }
  const bytes = new Uint8Array(offset);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { mime, bytes };
}

let nextId = 1;

/** BlobStore の選択（試験で URL の作り方を差し替える）。 */
export interface BlobStoreOptions {
  /** 覚えておく画像の数（既定は DEFAULT_MAX_BLOBS） */
  max?: number;
  makeUrl?: (b: Blob) => string;
  revokeUrl?: (url: string) => void;
}

/** 1 つのつなぎ先の画像の URL を覚えておく。 */
export class BlobStore implements BlobSource {
  readonly id = nextId++;
  private readonly cache = new Map<string, Promise<string>>();
  private readonly get: BlobFetch;
  private readonly opts: BlobStoreOptions;

  constructor(get: BlobFetch, opts: BlobStoreOptions = {}) {
    this.get = get;
    this.opts = opts;
  }

  url(ref: ImageRef): Promise<string> {
    const key = blobKey(ref);
    const hit = this.cache.get(key);
    if (hit) {
      // 新しく使った順に並べ直す
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const p = fetchBlob(this.get, ref.blob).then(({ mime, bytes }) =>
      (this.opts.makeUrl ?? ((b: Blob) => URL.createObjectURL(b)))(
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }),
      ),
    );
    this.cache.set(key, p);
    p.catch(() => {
      if (this.cache.get(key) === p) this.cache.delete(key);
    });
    this.trim();
    return p;
  }

  /** 覚えている画像を全部手放す。 */
  clear(): void {
    for (const p of this.cache.values()) this.release(p);
    this.cache.clear();
  }

  private trim(): void {
    const max = this.opts.max ?? DEFAULT_MAX_BLOBS;
    while (this.cache.size > max) {
      const [key, p] = this.cache.entries().next().value!;
      this.cache.delete(key);
      this.release(p);
    }
  }

  private release(p: Promise<string>): void {
    const revoke =
      this.opts.revokeUrl ?? ((u: string) => URL.revokeObjectURL(u));
    p.then(revoke, () => {});
  }
}
