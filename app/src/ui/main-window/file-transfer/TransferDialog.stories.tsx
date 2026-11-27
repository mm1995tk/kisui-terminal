// 組み合わせの例：ファイルの転送を許すかを聞く Dialog（TransferDialog.tsx）を、アプリと同じ部品・CSS・字・翻訳で出す。
// Dialog の枠（ModalCard、focusSelf）・本文・一覧（.transfer-list）・許さないと主ボタン（Button）の組み合わせ。
// 聞く仕組みは本物（features/file-transfer/transferPrompt.ts の askTransfer）で、聞く中身だけが見本のデータ。
import { onCleanup } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

import {
  askTransfer,
  type ReadItem,
  type TransferInfo,
} from "../../../features/file-transfer/transferPrompt.ts";
import { TransferDialog } from "./TransferDialog.tsx";

type Args = { info: TransferInfo };

/** 手元のファイルを読む頼み。渡したパスの普通のファイル（どれも 2 KiB）。 */
function readOf(paths: string[]): TransferInfo {
  const items: ReadItem[] = paths.map((path) => ({
    path,
    kind: "regular",
    size: 2048,
  }));
  return {
    direction: "read",
    items,
    files: items.length,
    totalSize: items.length * 2048,
  };
}

const meta = {
  title: "main-window/file-transfer/TransferDialog",
  args: { info: readOf(["/home/u/notes/todo.md", "/home/u/notes/plan.md"]) },
  render: (args) => {
    // story を出している間だけ聞く。離れたら取り下げる（次の story に残さない）
    const asking = askTransfer(args.info);
    onCleanup(asking.cancel);
    return <TransferDialog />;
  },
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 手元のファイルを読む頼み。少ないときは、一覧はスクロールしない。 */
export const Read: Story = {};

/**
 * 項目が多いとき。省かずに全部並べ、一覧の中でスクロールする（合計とボタンは見えたまま）。
 * Tab で一覧にフォーカスを移すと、矢印・PageDown で動く。
 */
export const ReadMany: Story = {
  args: {
    info: readOf(
      Array.from(
        { length: 300 },
        (_, i) => `/home/u/project/src/module-${i + 1}/index.ts`,
      ),
    ),
  },
};

/** ディレクトリを頼まれたとき（中のものも 1 つずつ並ぶ）と、長いパス（切らずに折り返す）。 */
export const ReadDirectory: Story = {
  args: {
    info: {
      direction: "read",
      items: [
        { path: "/home/u/work", kind: "directory", size: undefined },
        { path: "/home/u/work/report.pdf", kind: "regular", size: 734003 },
        { path: "/home/u/work/latest", kind: "symlink", size: undefined },
        {
          path: "/home/u/work/a-very-long-directory-name-that-does-not-fit-in-one-line/another-long-directory-name/2026-11-26-meeting-notes-final-version.txt",
          kind: "regular",
          size: 512,
        },
      ],
      files: 2,
      totalSize: 734515,
    },
  },
};

/** プログラムが手元にファイルを書く頼み。 */
export const Write: Story = {
  args: { info: { direction: "write", destination: "/home/u/Downloads" } },
};
