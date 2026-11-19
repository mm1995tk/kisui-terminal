// ツリーの右クリックのメニュー（とそのキー）から開く、削除の確認の窓。
// 名前を入れる操作（新規・名前の変更）は、窓を出さずにツリーの中のその場の入力欄で行う（TreeView.tsx）。
// 何を出すかは features/file-tree/controller.ts の状態で決まる。
import { Show, type JSX } from "solid-js";

import type { FileTree } from "../../../../features/file-tree/controller.ts";
import { DeleteDialog } from "./TreeDialogs.tsx";

/** ツリーのメニューから開いた削除の確認の窓を出す。開いていなければ何も描かない。 */
export function FileTreeDialogs(props: { fileTree: FileTree }): JSX.Element {
  // 部品は作り直さないので、持ち物は 1 回だけ取り出す
  const { treeDialog, closeTreeDialog, submitTreeDelete } = props.fileTree;
  return (
    <Show when={treeDialog()} keyed>
      {(d) => (
        <DeleteDialog
          path={d.path}
          dir={d.dir}
          onYes={submitTreeDelete}
          onCancel={closeTreeDialog}
        />
      )}
    </Show>
  );
}
