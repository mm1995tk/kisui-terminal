import { Image } from "@tauri-apps/api/image";
import {
  readImage,
  readText,
  writeImage,
  writeText,
} from "@tauri-apps/plugin-clipboard-manager";

import { READ_IMAGE, READ_TEXT, type WritePlan } from "./clipboard.ts";

/** OS のクリップボードに書く。画像は WebView で RGBA にしてから渡す（Rust 側に画像の復号を足さないため）。 */
export async function writeOs(plan: WritePlan): Promise<void> {
  if (plan.kind === "text") {
    await writeText(plan.text);
    return;
  }
  const bitmap = await createImageBitmap(new Blob([plan.bytes as BlobPart]));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    // Image は Rust 側の資源なので、渡し終えたら閉じる
    const image = await Image.new(data.buffer, bitmap.width, bitmap.height);
    try {
      await writeImage(image);
    } finally {
      await image.close();
    }
  } finally {
    bitmap.close();
  }
}

/** 今 OS のクリップボードにある種類（text/plain と image/png のうち）。中身はプログラムに渡さない。 */
export async function availableOs(): Promise<string[]> {
  const out: string[] = [];
  try {
    if ((await readText()).length > 0) out.push(READ_TEXT);
  } catch {
    // テキストが無い
  }
  try {
    await (await readImage()).close();
    out.push(READ_IMAGE);
  } catch {
    // 画像が無い
  }
  return out;
}

/** 指定の種類で読む。無ければ undefined。 */
export async function readOs(
  mime: string,
): Promise<{ mime: string; data: Uint8Array } | undefined> {
  try {
    if (mime === READ_TEXT) {
      const t = await readText();
      return t ? { mime, data: new TextEncoder().encode(t) } : undefined;
    }
    if (mime === READ_IMAGE) {
      const img = await readImage();
      try {
        const { width, height } = await img.size();
        const rgba = await img.rgba();
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return undefined;
        ctx.putImageData(
          new ImageData(new Uint8ClampedArray(rgba), width, height),
          0,
          0,
        );
        const blob = await canvas.convertToBlob({ type: "image/png" });
        return { mime, data: new Uint8Array(await blob.arrayBuffer()) };
      } finally {
        await img.close();
      }
    }
  } catch {
    // 読めなかった
  }
  return undefined;
}

/** 頼まれた順に試して、最初に読めたもの。 */
export async function readFirstOs(
  mimes: string[],
): Promise<{ mime: string; data: Uint8Array } | undefined> {
  for (const m of mimes) {
    const item = await readOs(m);
    if (item) return item;
  }
  return undefined;
}
