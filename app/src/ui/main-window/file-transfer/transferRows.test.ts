import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReadItem } from "../../../features/file-transfer/transferPrompt.ts";
import { readRows } from "./transferRows.ts";

describe("ファイルの送り出しの確認の窓の一覧", () => {
  it("13 件以上でも、項目 1 つに 1 行で、全部のパスが行に入る", () => {
    for (const n of [1, 12, 13, 500]) {
      const items: ReadItem[] = Array.from({ length: n }, (_, i) => ({
        path: `/home/u/dir/f${i + 1}.txt`,
        kind: "regular",
        size: 5,
      }));
      const rows = readRows(items);
      assert.equal(rows.length, n);
      items.forEach((item, i) => assert.ok(rows[i]!.includes(item.path)));
    }
  });

  it("ファイルは種類と大きさ、ディレクトリとリンクは種類を添える", () => {
    assert.deepEqual(
      readRows([
        { path: "/home/u/.ssh/id_ed25519", kind: "regular", size: 1536 },
        { path: "/home/u/d", kind: "directory", size: undefined },
        { path: "/home/u/d/l", kind: "symlink", size: undefined },
      ]),
      [
        "/home/u/.ssh/id_ed25519 (file, 1.5 KiB)",
        "/home/u/d (directory)",
        "/home/u/d/l (link)",
      ],
    );
  });
});
