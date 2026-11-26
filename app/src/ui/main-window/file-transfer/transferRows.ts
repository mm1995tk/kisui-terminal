// ファイルの送り出しの確認の窓（TransferDialog.tsx）の一覧の行。
// 許すと、ここに並んだファイルが全部読まれる。だから行は項目 1 つに 1 行で、数が多くても省かない
// （「ほか N 件」とまとめると、見えていないファイルまで許すことになる）。
import { T } from "../../../i18n/index.ts";
import { formatBytes } from "../../../features/file-transfer/transfer.ts";
import type { ReadItem } from "../../../features/file-transfer/transferPrompt.ts";

/** 一覧の行の文（項目と同じ数、同じ順）。どの行にも、その項目の手元の絶対パスが入る。 */
export function readRows(items: readonly ReadItem[]): string[] {
  return items.map((item) => {
    const kind = T(`transfer.kind.${item.kind}`);
    return item.size !== undefined
      ? T("transfer.read.itemSize", {
          path: item.path,
          kind,
          size: formatBytes(item.size),
        })
      : T("transfer.read.item", { path: item.path, kind });
  });
}
