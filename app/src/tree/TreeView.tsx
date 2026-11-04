// ツリー（D2）を描く。行は model.ts の rows、見た目は tree.css（モック「案：フラットな一覧」に合わせる）。
// フォルダの行は押すと開閉し、ファイルの行は押すと（Enter でも）ファイルの欄で開く（file.open。何をするかは model.ts の rowAction）。
// ファイルの欄でフォーカスしているペインが出しているファイルの行は強調する（モックと同じ背景）。
// 開いたフォルダの行は、中身をスクロールしている間だけ上に固定する（D3）。そのために行を親子の要素に組む。
import { Index, Match, Show, Switch, type JSX } from "solid-js";

import type { TreeIcon } from "./icons.ts";
import {
  nest,
  rowAction,
  type RowMark,
  type TreeNode,
  type TreeRow,
} from "./model.ts";
import "./tree.css";

/** 印の文字と、読み上げの言葉。 */
const markText: Record<string, string> = {
  M: "変更",
  A: "追加",
  D: "削除",
  R: "名前変更",
  "?": "追跡していない",
  U: "衝突",
  children: "中に変更あり",
};

function markLabel(m: RowMark): string {
  if (m.kind === "children") return markText.children;
  if (m.kind === "ignored") return "無視";
  return markText[m.letter];
}

/** 行を押したときに呼ぶものと、強調する行。 */
interface RowHandlers {
  onToggle: (path: string) => void;
  /** ファイルの行を押した（path はルートからの相対パス） */
  onOpen?: (path: string) => void;
  /** ファイルの欄で開いているファイル（強調する行の path） */
  current?: string;
}

/**
 * ツリー。rows が空でも枠は出す（取っている最中）。
 * 開いたフォルダの行は data-sticky を付け、中身をスクロールしている間は上に固定する
 * （固定する位置は --tree-sticky-top から深さ × 行の高さ下）。
 */
export function TreeView(
  props: RowHandlers & {
    rows: TreeRow[];
    label: string;
  },
): JSX.Element {
  return (
    <div class="tree" role="tree" aria-label={props.label}>
      <Nodes nodes={nest(props.rows)} handlers={props} />
    </div>
  );
}

/** 行とその中身を 1 つの要素に入れて並べる（sticky の行が、中身の要素の中だけで止まるように）。 */
function Nodes(props: {
  nodes: TreeNode[];
  handlers: RowHandlers;
}): JSX.Element {
  return (
    // 位置で使い回す（開閉で行が増減しても、押した行の要素とフォーカスが残る）
    <Index each={props.nodes}>
      {(n) => (
        <div class="tree-group">
          <Row row={n().row} handlers={props.handlers} />
          <Show when={n().children.length > 0}>
            <Nodes nodes={n().children} handlers={props.handlers} />
          </Show>
        </div>
      )}
    </Index>
  );
}

function Row(props: { row: TreeRow; handlers: RowHandlers }): JSX.Element {
  const r = () => props.row;
  const mark = () => r().mark;
  /** 押した（key が undefined）・キーを押した。何かしたら true。 */
  const act = (key?: string): boolean => {
    const a = rowAction(r(), key);
    if (a === "toggle") props.handlers.onToggle(r().path);
    else if (a === "open" && props.handlers.onOpen)
      props.handlers.onOpen(r().path);
    else return false;
    return true;
  };
  return (
    <Show
      when={!r().truncated}
      fallback={
        <div
          class="tree-row tree-truncated"
          role="treeitem"
          aria-level={r().depth + 1}
        >
          <Guides depth={r().depth} />
          <span class="tree-chevron" />
          <span class="tree-name">…（5000 件より先は出していません）</span>
        </div>
      }
    >
      <div
        class="tree-row"
        role="treeitem"
        aria-level={r().depth + 1}
        aria-expanded={r().dir ? r().expanded : undefined}
        aria-busy={r().loading ? "true" : undefined}
        aria-selected={
          !r().dir && props.handlers.current === r().path ? "true" : undefined
        }
        data-mark={markKey(mark())}
        data-sticky={r().dir && r().expanded ? "top" : undefined}
        style={{ "--tree-depth": String(r().depth) }}
        title={r().path}
        tabIndex={0}
        onClick={() => act()}
        onKeyDown={(e) => {
          if (act(e.key)) e.preventDefault();
        }}
      >
        <Guides depth={r().depth} />
        <Show when={r().dir} fallback={<span class="tree-chevron" />}>
          <svg
            class="tree-chevron"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path d={r().expanded ? "M4 6l4 4 4-4" : "M6 4l4 4-4 4"} />
          </svg>
        </Show>
        <TreeIconView icon={r().icon} />
        <span class="tree-name">{r().name}</span>
        <Show when={r().symlink}>
          <span
            class="tree-link"
            aria-label="シンボリックリンク"
            title="シンボリックリンク"
          >
            ↪
          </span>
        </Show>
        <Show when={mark() && mark()!.kind !== "ignored"}>
          <span class="tree-mark" role="img" aria-label={markLabel(mark()!)}>
            {mark()!.kind === "file"
              ? (mark() as { letter: string }).letter
              : "•"}
          </span>
        </Show>
      </div>
    </Show>
  );
}

/** 色分けに使う印のキー（tree.css の data-mark）。 */
function markKey(m: RowMark | null): string | undefined {
  if (!m) return undefined;
  if (m.kind === "file") return m.letter === "?" ? "untracked" : m.letter;
  return m.kind;
}

/** 深さぶんの縦線（親フォルダの矢印の下に引く）。 */
function Guides(props: { depth: number }): JSX.Element {
  return (
    <Index each={Array.from({ length: props.depth })}>
      {() => <span class="tree-guide" aria-hidden="true" />}
    </Index>
  );
}

/** ファイルとフォルダのアイコン。形はモックの SVG。 */
export function TreeIconView(props: { icon: TreeIcon }): JSX.Element {
  return (
    <svg
      class="tree-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <Switch
        fallback={
          <>
            <path
              d="M3 1.5h6.5l3.5 3.5v9.5h-10z"
              fill="none"
              stroke={props.icon.color}
              stroke-width="1.2"
            />
            <Show
              when={props.icon.label}
              fallback={
                <path
                  d="M5.5 8h5M5.5 10.5h5"
                  stroke={props.icon.color}
                  stroke-width="1.2"
                />
              }
            >
              <text
                x="8"
                y="12"
                text-anchor="middle"
                font-size={(props.icon.label?.length ?? 0) > 2 ? "4.2" : "5.5"}
                font-weight="700"
                fill={props.icon.color}
                font-family="sans-serif"
              >
                {props.icon.label}
              </text>
            </Show>
          </>
        }
      >
        <Match when={props.icon.kind === "folder"}>
          <path d="M1.5 3h4.5l1.5 1.5h7v8.5h-13z" fill={props.icon.color} />
        </Match>
        <Match when={props.icon.kind === "folder-open"}>
          <path
            d="M1.5 3h4.5l1.5 1.5h6v2h-9.5l-2.5 6.5z"
            fill={props.icon.color}
          />
          <path d="M4 7h11l-2.5 6h-11z" fill="#9dbbd8" />
        </Match>
      </Switch>
    </svg>
  );
}
