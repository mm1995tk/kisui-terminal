// ツリーの右クリックのメニュー（とそのキー）から開く窓。名前を入れる（新規・名前の変更）と、削除の確認。
// 何を出すかは features/file-tree/controller.ts の状態で決まる。
import { T } from "../../../../i18n/index.ts";
import { Show, type JSX } from "solid-js";

import type { FileTree } from "../../../../features/file-tree/controller.ts";
import { newEntryDefault } from "../../../../features/file-tree/menu.ts";
import { DeleteDialog, NameDialog } from "./TreeDialogs.tsx";

export function FileTreeDialogs(props: { fileTree: FileTree }): JSX.Element {
  // 部品は作り直さないので、持ち物は 1 回だけ取り出す
  const { treeDialog, closeTreeDialog, submitTreeName, submitTreeDelete } =
    props.fileTree;
  return (
    <Show when={treeDialog()} keyed>
      {(d) => (
        <Show
          when={d.kind === "delete"}
          fallback={
            <NameDialog
              title={
                d.kind === "new-file"
                  ? T("dialog.tree.newFile")
                  : d.kind === "new-dir"
                    ? T("dialog.tree.newDir")
                    : T("dialog.tree.rename")
              }
              field={
                d.kind === "rename"
                  ? T("dialog.tree.newPath")
                  : T("dialog.tree.path")
              }
              initial={d.kind === "rename" ? d.path : newEntryDefault(d.path)}
              submit={
                d.kind === "rename"
                  ? T("dialog.tree.renameSubmit")
                  : T("dialog.tree.createSubmit")
              }
              selectName={d.kind === "rename"}
              onSubmit={submitTreeName}
              onCancel={closeTreeDialog}
            />
          }
        >
          <DeleteDialog
            path={d.path}
            dir={d.dir}
            onYes={submitTreeDelete}
            onCancel={closeTreeDialog}
          />
        </Show>
      )}
    </Show>
  );
}
