// DB のタブ（#347）を出している間に、右のペインに出す画面。グリッドの場所すべてを覆う（ブラウザのページ・空のワークスペースの画面と同じ）。
// 上に SQL の入力欄、下に結果の表、その下に件数とかかった時間を出す。
// 中身（書きかけの SQL・結果・実行中の印）は features/db/controller.ts が持ち、ここは出すことと入力だけ。
// 左に、スキーマとテーブルの木のペイン（#348。db/DbTree.tsx）がある（閉じられる。幅はつまみで変えられる）。
import { T } from "../../../../i18n/index.ts";
import {
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  type JSX,
} from "solid-js";

import type {
  DbCatalogState,
  DbRun,
} from "../../../../features/db/controller.ts";
import { dbEditorKey } from "../../../../features/db/keys.ts";
import { cellText, resultSummary } from "../../../../features/db/model.ts";
import type { DbQueryResult } from "../../../../infrastructure/rpc/protocol.ts";
import { clampTreeWidth } from "../../../../features/db/tree.ts";
import { Button } from "../../../components/Button.tsx";
import { DbTree } from "./DbTree.tsx";
import styles from "./DbTabView.module.css";

/** DB のタブの画面。 */
export function DbTabView(props: {
  /** 接続の名前（そのマシンの [[db.connections]] の name。t r で付けたタブの名前ではない）とマシン（読み上げと見出し） */
  connection: string;
  machine: string;
  /** macOS か（実行のキーの書き方と判定） */
  mac: boolean;
  /** 入力欄の SQL */
  sql: string;
  onSql: (sql: string) => void;
  run: DbRun;
  onRun: () => void;
  onCancel: () => void;
  /** 左の木のペイン（#348） */
  tree: {
    open: boolean;
    width: number;
    onWidth: (width: number) => void;
    catalog: DbCatalogState;
    expanded: ReadonlySet<string>;
    onToggle: (node: string, open: boolean) => void;
    onPreview: (schema: string, table: string) => void;
    onReload: () => void;
  };
  /** SQL の入力欄にキーを向ける関数を受け取る（消えるときは undefined） */
  focusRef?: (f: (() => void) | undefined) => void;
}): JSX.Element {
  let input!: HTMLTextAreaElement;
  props.focusRef?.(() => input.focus());
  onCleanup(() => props.focusRef?.(undefined));
  const [dragging, setDragging] = createSignal(false);
  /** つまみで木のペインの幅を変える（つまみの位置が、木の右端になる） */
  function dragSeparator(e: PointerEvent) {
    const bar = e.currentTarget as HTMLElement;
    const left = bar.parentElement!.getBoundingClientRect().left;
    bar.setPointerCapture(e.pointerId);
    setDragging(true);
    const move = (m: PointerEvent) =>
      props.tree.onWidth(clampTreeWidth(m.clientX - left));
    const up = () => {
      setDragging(false);
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", up);
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
    e.preventDefault();
  }
  const runKey = () => (props.mac ? "Cmd+Enter" : "Ctrl+Enter");
  /** 最後の実行の間違い（取り消しは除く） */
  const error = () => {
    const f = props.run.failure;
    return f?.kind === "error" ? f : undefined;
  };

  function onKeyDown(e: KeyboardEvent) {
    const a = dbEditorKey(e, props.mac);
    if (!a) return;
    if (a === "cancel" && !props.run.running) return;
    e.preventDefault();
    e.stopPropagation();
    if (a === "run") props.onRun();
    else props.onCancel();
  }

  return (
    <div
      class={styles.root}
      role="region"
      aria-label={T("db.view.label", { connection: props.connection })}
      data-place="db"
    >
      <Show when={props.tree.open}>
        <div class={styles.treePane} style={{ width: `${props.tree.width}px` }}>
          <DbTree
            catalog={props.tree.catalog}
            expanded={props.tree.expanded}
            onToggle={props.tree.onToggle}
            onPreview={props.tree.onPreview}
            onReload={props.tree.onReload}
            onLeave={() => input.focus()}
          />
        </div>
        <div
          class={styles.separator}
          role="separator"
          aria-orientation="vertical"
          data-dragging={dragging() ? "" : undefined}
          onPointerDown={dragSeparator}
        />
      </Show>
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
                onClick={props.onRun}
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
              {(r) => <ResultTable result={r()} />}
            </Match>
          </Switch>
        </div>
        <Show when={!props.run.running && props.run.result}>
          {(r) => (
            <div class={styles.status} role="status">
              {resultSummary(r())}
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}

/** 結果の表。数の列は右に寄せ、NULL は印で出し、長い値は切る（全部はツールチップ）。 */
function ResultTable(props: { result: DbQueryResult }): JSX.Element {
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
              <Head result={props.result} />
            </table>
            <p class={styles.note}>{T("db.view.noRows")}</p>
          </>
        }
      >
        <table class={styles.table}>
          <Head result={props.result} />
          <tbody>
            <For each={props.result.rows}>
              {(row) => (
                <tr>
                  <For each={row}>
                    {(v, i) => {
                      const text = cellText(v);
                      return (
                        <td
                          class={styles.cell}
                          data-kind={props.result.columns[i()]?.kind}
                          data-null={text === null ? "" : undefined}
                          title={v !== null && v !== text ? v : undefined}
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

/** 表の見出し（列の名前。型はツールチップ）。 */
function Head(props: { result: DbQueryResult }): JSX.Element {
  return (
    <thead>
      <tr>
        <For each={props.result.columns}>
          {(c) => (
            <th class={styles.th} title={c.type} data-kind={c.kind}>
              {c.name}
            </th>
          )}
        </For>
      </tr>
    </thead>
  );
}
