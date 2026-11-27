// サイドバーの、タブの段の下の部分（ファイルツリーと CHANGES）。描くのは file-tree/TreeView.tsx と changes/ChangesView.tsx。
// DB のタブを出している間（#374）は、ファイルツリーの場所にそのタブの接続の木（db-tree/DbTree.tsx）を出し、ファイルツリーと CHANGES は外さずに見えなくする（状態を保つ）。
import { T } from "../../../i18n/index.ts";
import { Show, type JSX } from "solid-js";

import type { Row } from "../../../features/workspaces/rows.ts";
// CSS を持つ部品の import は、この順（CHANGES → ツリー → DB の木）を変えない（理由は ../page.tsx）
import { ChangesView } from "./changes/ChangesView.tsx";
import { TreeView } from "./file-tree/TreeView.tsx";
import { DbTree } from "./db-tree/DbTree.tsx";
import { dbTreeTabOf, type Handlers } from "./handlers.ts";

/**
 * タブの段の下の、ファイルツリーの段と CHANGES の段（プライマリで shj が動いている、フォーカスしているワークスペースだけ）。
 * 境目（タブの段との）をつかむ所も、ここに置く。
 */
export function Panes(props: Handlers & { row: Row }): JSX.Element {
  const b = () => props.row.band;
  // 出している DB のタブの id（この帯がフォーカスしているときだけ。DB の木は、フォーカスしているワークスペースのタブのもの）
  const dbTab = () => dbTreeTabOf(props, b().focused);
  // ブラウザのタブを出している間は、外さずに見えなくして、状態を保つ（#268。隠すのは帯の data-panes-hidden、sidebar.css）
  return (
    <div class="panes" data-db={dbTab() !== undefined ? "" : undefined}>
      <div class="tabs-border">
        <div
          class="tabs-resizer"
          data-border="tabs"
          aria-hidden="true"
          onPointerDown={(e) => props.onTabsResize?.(e)}
          onDblClick={() => props.onTabsResizeReset?.()}
        />
      </div>
      {/* DB のタブを出している間の木。ほかのタブに移れば消え、ファイルツリーに戻る */}
      <Show when={dbTab()} keyed>
        {(id) => (
          <div class="tree-section db-tree-section">
            <DbTree {...props.dbTree!(id)} />
          </div>
        )}
      </Show>
      {/* ファイルツリーの段。ツリーはこの段の中だけでスクロールする（行を出していなくても、段は残す） */}
      <div class="tree-section">
        <Show when={b().focused && props.treeOf?.(props.row.target, b().id)}>
          {(rows) => (
            <TreeView
              rows={rows()}
              label={T("sidebar.files", { title: b().title })}
              onToggle={(p) => props.onToggle?.(props.row.target, b().id, p)}
              onOpen={(p) => props.onOpen?.(props.row.target, b().id, p)}
              current={props.currentOf?.(props.row.target, b().id)}
              onMenu={
                props.onTreeMenu
                  ? (row, x, y) =>
                      props.onTreeMenu?.(props.row.target, b().id, row, x, y)
                  : undefined
              }
              onAction={
                props.onTreeAction
                  ? (row, a) =>
                      props.onTreeAction?.(props.row.target, b().id, row, a)
                  : undefined
              }
              edit={props.treeEditOf?.(props.row.target, b().id)}
              onEditSubmit={(v) => props.onTreeEditSubmit?.(v)}
              onEditCancel={(byKey) => props.onTreeEditCancel?.(byKey)}
            />
          )}
        </Show>
      </div>
      <Show when={b().focused && props.changesOf?.(props.row.target, b().id)}>
        {(c) => (
          <ChangesView
            rows={c().rows}
            base={c().base}
            label={T("sidebar.changes", { title: b().title })}
            onSelect={(p) => props.onChange?.(props.row.target, b().id, p)}
            onShjKey={(k) => props.onChangesKey?.(props.row.target, b().id, k)}
            onExplorer={() =>
              props.onChangesExplorer?.(props.row.target, b().id)
            }
            onLeave={() => props.onChangesLeave?.(props.row.target, b().id)}
            onResizeStart={props.onChangesResize}
            onResizeReset={props.onChangesResizeReset}
          />
        )}
      </Show>
    </div>
  );
}
