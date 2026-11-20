// DB のタブ（#347）を出している間に、右のペインに出す画面。グリッドの場所すべてを覆う（ブラウザのページ・空のワークスペースの画面と同じ）。
// 上に SQL の入力欄、下に結果の表、その下に件数とかかった時間を出す。
// 中身（書きかけの SQL・結果・実行中の印）は features/db/controller.ts が持ち、ここは出すことと入力だけ。
// スキーマとテーブルの木は、サイドバーのファイルツリーの場所に出す（#348・#374。sidebar/db-tree/DbTree.tsx）。
import { T } from "../../../../i18n/index.ts";
import {
  createEffect,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  type JSX,
} from "solid-js";

import type { DbRun } from "../../../../features/db/controller.ts";
import { dbEditorKey, dbResultKey } from "../../../../features/db/keys.ts";
import { cellText, resultSummary } from "../../../../features/db/model.ts";
import {
  ariaSort,
  canStep,
  pageable,
  sortable,
  type DbSort,
  type PageStep,
} from "../../../../features/db/paging.ts";
import type { DbQueryResult } from "../../../../infrastructure/rpc/protocol.ts";
import {
  clampRange,
  inRange,
  rangeText,
  type CellPos,
  type CellRange,
} from "../../../../features/db/selection.ts";
import { Button } from "../../../components/Button.tsx";
import styles from "./DbTabView.module.css";

/** DB のタブの画面。 */
export function DbTabView(props: {
  /** 接続の名前（そのマシンの [[db.connections]] の name。環境の変種があれば `接続 (変種)`。t r で付けたタブの名前ではない）とマシン（読み上げと見出し） */
  connection: string;
  machine: string;
  /** macOS か（実行のキーの書き方と判定） */
  mac: boolean;
  /** 入力欄の SQL */
  sql: string;
  onSql: (sql: string) => void;
  run: DbRun;
  /** 実行する。入力欄の字と、選んでいる範囲（選んでいなければ、どちらもカーソルの位置）を渡す。何を実行するかは features/db/ が決める（#375） */
  onRun: (text: string, selStart: number, selEnd: number) => void;
  /** 結果のページを切り替える（#373） */
  onPage: (step: PageStep) => void;
  /** 列 column（0 から数える）で並べ替える（#377）。押すたびに昇順 → 降順 → 並べ替えなし */
  onSort: (column: number) => void;
  onCancel: () => void;
  /** 結果の表で選んだセルをコピーする（#372） */
  onCopyCells: (text: string) => void;
  /** SQL の入力欄にキーを向ける関数を受け取る（消えるときは undefined） */
  focusRef?: (f: (() => void) | undefined) => void;
}): JSX.Element {
  let input!: HTMLTextAreaElement;
  props.focusRef?.(() => input.focus());
  onCleanup(() => props.focusRef?.(undefined));
  const runKey = () => (props.mac ? "Cmd+Enter" : "Ctrl+Enter");
  /** 最後の実行の間違い（取り消しは除く） */
  const error = () => {
    const f = props.run.failure;
    return f?.kind === "error" ? f : undefined;
  };

  /** 入力欄で選んでいる部分か、選んでいなければカーソルのある文を実行する（#375） */
  function runSelected() {
    props.onRun(input.value, input.selectionStart, input.selectionEnd);
  }

  function onKeyDown(e: KeyboardEvent) {
    const a = dbEditorKey(e, props.mac);
    if (!a) return;
    if (a === "cancel" && !props.run.running) return;
    e.preventDefault();
    e.stopPropagation();
    if (a === "run") runSelected();
    else props.onCancel();
  }

  return (
    <div
      class={styles.root}
      role="region"
      aria-label={T("db.view.label", { connection: props.connection })}
      data-place="db"
    >
      <div class={styles.query}>
        <div class={styles.head}>
          <span class={styles.title}>
            {T("dbTab.tip", {
              connection: props.connection,
              machine: props.machine,
            })}
          </span>
          <Show
            when={props.run.running}
            fallback={
              <Button
                variant="primary"
                disabled={props.sql.trim() === ""}
                onClick={runSelected}
              >
                {T("db.view.run")}
              </Button>
            }
          >
            <Button onClick={props.onCancel}>{T("db.view.cancel")}</Button>
          </Show>
        </div>
        <textarea
          ref={input}
          class={styles.sql}
          value={props.sql}
          spellcheck={false}
          autocapitalize="off"
          autocomplete="off"
          aria-label={T("db.view.sql")}
          placeholder={T("db.view.placeholder", { key: runKey() })}
          onInput={(e) => props.onSql(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <div
          class={styles.result}
          role="region"
          aria-label={T("db.view.result")}
          aria-busy={props.run.running ? "true" : undefined}
        >
          <Switch fallback={<p class={styles.note}>{T("db.view.empty")}</p>}>
            <Match when={props.run.running}>
              <p class={styles.note}>{T("db.view.running")}</p>
            </Match>
            <Match when={props.run.failure?.kind === "cancelled"}>
              <p class={styles.note}>{T("db.view.cancelled")}</p>
            </Match>
            <Match when={error()}>
              {(err) => (
                <div class={styles.error} role="alert">
                  <Show when={err().sqlState}>
                    {(code) => (
                      <span class={styles.code}>
                        {T("db.view.sqlState", { code: code() })}
                      </span>
                    )}
                  </Show>
                  <pre class={styles.message}>{err().message}</pre>
                </div>
              )}
            </Match>
            <Match when={props.run.result}>
              {(r) => (
                <ResultTable
                  result={r()}
                  mac={props.mac}
                  onCopy={props.onCopyCells}
                  sort={props.run.page?.sort}
                  onSort={
                    props.run.running || !sortable(r())
                      ? undefined
                      : props.onSort
                  }
                />
              )}
            </Match>
          </Switch>
        </div>
        <Show when={props.run.result}>
          {(r) => (
            <div class={styles.status}>
              <span role="status">
                {props.run.running ? "" : resultSummary(r())}
              </span>
              {/* ページ送り（#373）。包める文で 2 ページ以上あるときだけ出す。実行している間は押せない */}
              <Show
                when={
                  props.run.page && pageable(r()) ? props.run.page : undefined
                }
              >
                {(page) => (
                  <div
                    class={styles.pager}
                    role="group"
                    aria-label={T("db.view.pages")}
                  >
                    <Button
                      disabled={
                        !!props.run.running || !canStep(r(), page(), "prev")
                      }
                      onClick={() => props.onPage("prev")}
                    >
                      {T("db.view.prevPage")}
                    </Button>
                    <Button
                      disabled={
                        !!props.run.running || !canStep(r(), page(), "next")
                      }
                      onClick={() => props.onPage("next")}
                    >
                      {T("db.view.nextPage")}
                    </Button>
                  </div>
                )}
              </Show>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}

/**
 * 結果の表。数の列は右に寄せ、NULL は印で出し、長い値は切る（全部はツールチップ）。
 * セルはクリックで選び、Shift+クリックかドラッグで矩形に広げ、Cmd+C / Ctrl+C でコピーする（#372。コピーする文字は
 * features/db/selection.ts）。表にフォーカスがあるときだけキーを受ける。
 */
function ResultTable(props: {
  result: DbQueryResult;
  mac: boolean;
  onCopy: (text: string) => void;
  /** 並べ替えている列と、列を押したときの動き（並べ替えられない結果・実行している間は undefined） */
  sort: DbSort | undefined;
  onSort: ((column: number) => void) | undefined;
}): JSX.Element {
  const [range, setRange] = createSignal<CellRange | null>(null);
  let dragging = false;
  // 結果が入れ替わったら、選びを表の大きさに収める（収まるセルが無ければ外す）
  createEffect(() => {
    const r = props.result;
    setRange((cur) => clampRange(cur, r));
  });
  const stopDrag = () => {
    dragging = false;
  };
  window.addEventListener("pointerup", stopDrag);
  onCleanup(() => window.removeEventListener("pointerup", stopDrag));

  function down(e: PointerEvent, pos: CellPos) {
    if (e.button !== 0) return;
    // 文字の選びが走らないようにして、表にフォーカスを向ける
    e.preventDefault();
    (e.currentTarget as HTMLElement).closest("table")?.focus();
    const cur = range();
    setRange(
      e.shiftKey && cur
        ? { anchor: cur.anchor, focus: pos }
        : { anchor: pos, focus: pos },
    );
    dragging = true;
  }
  function enter(e: PointerEvent, pos: CellPos) {
    if (!dragging) return;
    // 窓の外で離して pointerup が届かなかったときの備え：今ボタンが押されていなければ、ドラッグは終わっている
    if ((e.buttons & 1) === 0) {
      dragging = false;
      return;
    }
    setRange((cur) => (cur ? { anchor: cur.anchor, focus: pos } : cur));
  }
  function keydown(e: KeyboardEvent) {
    const a = dbResultKey(e, props.mac);
    const r = range();
    if (a === null || r === null) return;
    e.preventDefault();
    if (a === "copy") props.onCopy(rangeText(props.result, r));
    else props.onSort?.(r.focus.col);
  }

  return (
    <Show
      when={props.result.columns.length > 0}
      fallback={<p class={styles.note}>{T("db.view.noTable")}</p>}
    >
      <Show
        when={props.result.rows.length > 0}
        fallback={
          <>
            <table class={styles.table}>
              <Head
                result={props.result}
                sort={props.sort}
                onSort={props.onSort}
              />
            </table>
            <p class={styles.note}>{T("db.view.noRows")}</p>
          </>
        }
      >
        <table
          class={styles.table}
          tabindex={0}
          data-place="dbResult"
          onKeyDown={keydown}
        >
          <Head result={props.result} sort={props.sort} onSort={props.onSort} />
          <tbody>
            <For each={props.result.rows}>
              {(row, r) => (
                <tr>
                  <For each={row}>
                    {(v, i) => {
                      const text = cellText(v);
                      const pos = (): CellPos => ({ row: r(), col: i() });
                      return (
                        <td
                          class={styles.cell}
                          data-kind={props.result.columns[i()]?.kind}
                          data-null={text === null ? "" : undefined}
                          data-selected={
                            inRange(range(), pos()) ? "" : undefined
                          }
                          title={v !== null && v !== text ? v : undefined}
                          onPointerDown={(e) => down(e, pos())}
                          onPointerEnter={(e) => enter(e, pos())}
                        >
                          {text ?? "NULL"}
                        </td>
                      );
                    }}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </Show>
  );
}

/**
 * 表の見出し（列の名前。型はツールチップ）。押すと、その列で並べ替える（#377。昇順 → 降順 → なし）。
 * 並べ替えている列には、向きの印（▲ 昇順・▼ 降順）を付ける。
 */
function Head(props: {
  result: DbQueryResult;
  sort: DbSort | undefined;
  onSort: ((column: number) => void) | undefined;
}): JSX.Element {
  return (
    <thead>
      <tr>
        <For each={props.result.columns}>
          {(c, i) => (
            <th
              class={styles.th}
              title={c.type}
              data-kind={c.kind}
              data-sortable={props.onSort ? "" : undefined}
              aria-sort={ariaSort(props.sort, i())}
              onClick={() => props.onSort?.(i())}
            >
              {c.name}
              <Show when={ariaSort(props.sort, i())}>
                {(dir) => (
                  <span class={styles.sortMark} aria-hidden="true">
                    {dir() === "ascending" ? "▲" : "▼"}
                  </span>
                )}
              </Show>
            </th>
          )}
        </For>
      </tr>
    </thead>
  );
}
