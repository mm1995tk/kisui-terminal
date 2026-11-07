// ツリー（D2）を描く。行は model.ts の rows、見た目は tree.css（モック「案：フラットな一覧」に合わせる）。
// フォルダの行は押すと開閉し、ファイルの行は押すと（Enter でも）プライマリの shj で開く（shj.open。何をするかは model.ts の rowAction）。
// プライマリの shj が出しているファイルの行は強調する（モックと同じ背景）。
// 開いたフォルダの行は、中身をスクロールしている間だけ上に固定する（D3）。そのために行を親子の要素に組む。
// 行にフォーカスがあるときは shj のファイルツリーと同じキーで動かせる（#13。割り当ては keys.ts）。
import { Index, Match, onCleanup, Show, Switch, type JSX } from "solid-js";

import type { TreeIcon } from "./icons.ts";
import { treeKey, type TreeMove } from "./keys.ts";
import type { TreeMenuAction } from "./menu.ts";
import {
  nest,
  parentOf,
  ROOT,
  rowAction,
  type RowAction,
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
  /** プライマリの shj が出しているファイル（強調する行の path） */
  current?: string;
  /** 行を右クリックした（画面上の位置つき）。省くとメニューを出さない */
  onMenu?: (row: TreeRow, x: number, y: number) => void;
  /** 行でキーを押して、メニューの項目と同じ操作をする（a で新しいファイルなど）。省くとそのキーは使わない */
  onAction?: (row: TreeRow, action: TreeMenuAction) => void;
}

/** 行 from のあるツリーの、フォーカスできる行（上から順）。 */
function focusableRows(from: HTMLElement): HTMLElement[] {
  const tree = from.closest(".tree");
  return tree
    ? [...tree.querySelectorAll<HTMLElement>(".tree-row[tabindex]")]
    : [];
}

/**
 * フォーカスしている行 el が DOM から外れる（グループの最後の行を消した・親を閉じた）なら、残った一番近い前の行にフォーカスを移し、
 * 続けてキーで動かせるようにする。Solid は DOM から外す前に onCleanup を呼ぶので、そこから呼ぶ。
 * （Index は位置で要素を使い回すので、途中の行を消しても、フォーカスしている要素はふつう消えない）
 */
function keepFocusWhenRemoved(el: HTMLElement) {
  if (document.activeElement !== el) return;
  const all = focusableRows(el);
  const before = all.slice(0, all.indexOf(el)).reverse();
  queueMicrotask(() => {
    if (el.isConnected) return;
    before.find((x) => x.isConnected)?.focus({ preventScroll: true });
  });
}

/** ツリーの中で、行 from から to へフォーカスを移す。 */
function moveFocus(from: HTMLElement, path: string, to: TreeMove) {
  const all = focusableRows(from);
  const i = all.indexOf(from);
  let next: HTMLElement | undefined;
  if (to === "next") next = all[i + 1];
  else if (to === "prev") next = i > 0 ? all[i - 1] : undefined;
  else if (to === "first") next = all[0];
  else if (to === "last") next = all[all.length - 1];
  else {
    const parent = parentOf(path);
    if (parent !== ROOT) next = all.find((el) => el.dataset.path === parent);
  }
  if (!next || next === from) return;
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

/** 行を押した・Enter などを押したときの操作をする。何かしたら true。 */
function runRowAction(
  row: TreeRow,
  handlers: RowHandlers,
  a: RowAction | null,
): boolean {
  if (a === "toggle") handlers.onToggle(row.path);
  else if (a === "open" && handlers.onOpen) handlers.onOpen(row.path);
  else return false;
  return true;
}

/** 行でキーを押した。何かしたら true（ブラウザの既定の動き・スクロールを止める）。 */
function rowKeyDown(
  row: TreeRow,
  handlers: RowHandlers,
  e: KeyboardEvent & { currentTarget: HTMLElement },
): boolean {
  const a = treeKey(row, e);
  if (!a) return false;
  if (a.kind === "row") return runRowAction(row, handlers, a.action);
  if (a.kind === "move") {
    // 端にいて動けなくても、↑ ↓ で一覧がスクロールしないように止める
    moveFocus(e.currentTarget, row.path, a.to);
    return true;
  }
  if (!handlers.onAction) return false;
  handlers.onAction(row, a.action);
  return true;
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
    <>
      <div class="tree" role="tree" aria-label={props.label}>
        <Nodes nodes={nest(props.rows)} handlers={props} />
      </div>
    </>
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
  let el: HTMLDivElement | undefined;
  onCleanup(() => el && keepFocusWhenRemoved(el));
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
        ref={el}
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
        data-path={r().path}
        tabIndex={0}
        onClick={() => runRowAction(r(), props.handlers, rowAction(r()))}
        onContextMenu={(e) => {
          if (!props.handlers.onMenu) return;
          e.preventDefault();
          props.handlers.onMenu(r(), e.clientX, e.clientY);
        }}
        onKeyDown={(e) => {
          if (rowKeyDown(r(), props.handlers, e)) e.preventDefault();
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
