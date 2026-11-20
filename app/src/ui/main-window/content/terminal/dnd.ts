import type { DndLocation, DropRequest } from "coneko-term";

/** 落とされたものの 1 項目。MIME の種類と、読む関数（ファイルは頼まれるまで読まない）。 */
export interface DropItem {
  mime: string;
  read: () => Promise<Uint8Array>;
}

/** ファイルの MIME の種類が分からないとき */
export const UNKNOWN_FILE_MIME = "application/octet-stream";

/**
 * ドラッグ中（中身はまだ読めない）に見える情報から、落とされたものの MIME の種類の並びを作る。
 * テキスト系（`types`。ファイルを表す "Files" は除く）が先、ファイルがあとで、落とされたあと
 * `collectDrop` が作る並びと同じ順。プログラムは、この並びの番号でデータを頼む。
 */
export function offeredMimes(
  types: readonly string[],
  items: readonly { kind: string; type: string }[],
): string[] {
  const out = types.filter((t) => t !== "Files");
  for (const it of items) {
    if (it.kind === "file") out.push(it.type || UNKNOWN_FILE_MIME);
  }
  return out;
}

/**
 * ドロップされた瞬間に呼ぶ（テキストはこの中でしか読めない）。ファイルの中身は、
 * プログラムが頼んだときに読む（ユーザーが落としたものだけが対象）。
 */
export function collectDrop(dt: DataTransfer): DropItem[] {
  const enc = new TextEncoder();
  const out: DropItem[] = [];
  for (const t of Array.from(dt.types)) {
    if (t === "Files") continue;
    const bytes = enc.encode(dt.getData(t));
    out.push({ mime: t, read: async () => bytes });
  }
  for (const f of Array.from(dt.files)) {
    out.push({
      mime: f.type || UNKNOWN_FILE_MIME,
      read: async () => new Uint8Array(await f.arrayBuffer()),
    });
  }
  return out;
}

/** 欄の中の画面上の位置を、ターミナルのセルと画素の位置にする（欄の外にはみ出したら端に寄せる）。 */
export function locate(
  rect: { left: number; top: number },
  cell: { width: number; height: number },
  grid: { cols: number; rows: number },
  client: { x: number; y: number },
): DndLocation {
  const px = Math.max(0, Math.floor(client.x - rect.left));
  const py = Math.max(0, Math.floor(client.y - rect.top));
  const col = Math.max(0, Math.min(grid.cols - 1, Math.floor(px / cell.width)));
  const row = Math.max(
    0,
    Math.min(grid.rows - 1, Math.floor(py / cell.height)),
  );
  return {
    x: col,
    y: row,
    pixelX: Math.max(0, Math.round(px - col * cell.width)),
    pixelY: Math.max(0, Math.round(py - row * cell.height)),
  };
}

/** `dropRequest` への答えを決める。`data` は番号（1 始まり）のデータ。それ以外は断る。 */
export function resolveRequest(
  req: DropRequest,
  items: readonly DropItem[],
):
  | { kind: "data"; item: DropItem }
  | { kind: "error"; error: "ENOENT" | "EINVAL" }
  | { kind: "none" } {
  switch (req.type) {
    case "data": {
      const item = items[req.index - 1];
      return item ? { kind: "data", item } : { kind: "error", error: "ENOENT" };
    }
    case "dirClose":
      return { kind: "none" };
    default:
      // ファイルのパスもディレクトリも渡さない（中身だけを MIME の種類ごとに渡す）
      return { kind: "error", error: "EINVAL" };
  }
}
