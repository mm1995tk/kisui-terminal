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
import {
  dbEditorKey,
  dbResultKey,
  dbResultTabKey,
} from "../../../../features/db/keys.ts";
import {
  activeRunning,
  activeStatement,
  resultTabLabel,
} from "../../../../features/db/results.ts";
import { cellText, resultSummary } from "../../../../features/db/model.ts";
import {
  ariaSort,
  canStep,
  pageable,
  sortable,
  type DbSort,
  type PageStep,
} from "../../../../features/db/paging.ts";
import type {
  DbQueryResult,
  DbStructure,
} from "../../../../infrastructure/rpc/protocol.ts";
import {
  indexKindText,
  keyColumnsText,
  referenceText,
  type DbResultView,
  type DbStructureState,
} from "../../../../features/db/structure.ts";
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
  /** 文を 2 つ以上実行したときの、結果のタブ（#380）：index の文の結果を出す・step だけ動かす */
  onResult: (index: number) => void;
  onStepResult: (step: 1 | -1) => void;
  /** 木で選んだテーブルと、その構造・結果の場所に出している側（#379）。テーブルを選んでいなければ undefined（切り替えを出さない） */
  structure: DbStructureState | undefined;
  /** 結果の場所に view を出す（#379） */
  onView: (view: DbResultView) => void;
  /** SQL の入力欄にキーを向ける関数を受け取る（消えるときは undefined） */
  focusRef?: (f: (() => void) | undefined) => void;
}): JSX.Element {
  let input!: HTMLTextAreaElement;
  props.focusRef?.(() => input.focus());
  onCleanup(() => props.focusRef?.(undefined));
  const runKey = () => (props.mac ? "Cmd+Enter" : "Ctrl+Enter");

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

  /** 結果の場所に出している側（#379）。テーブルを選んでいなければ、いつもデータ */
  const view = (): DbResultView => props.structure?.view ?? "data";

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
        {/* 結果の場所の切り替え（#379）。木でテーブルを選んだときだけ出す */}
        <Show when={props.structure}>
          {(s) => (
            <ViewSwitch
              view={s().view}
              table={`${s().table.schema}.${s().table.table}`}
              onView={props.onView}
            />
          )}
        </Show>
        <Show
          when={view() === "data"}
          fallback={
            <Show when={props.structure}>
              {(s) => <StructureView state={s()} />}
            </Show>
          }
        >
          <DataView
            run={props.run}
            mac={props.mac}
            onPage={props.onPage}
            onSort={props.onSort}
            onCopyCells={props.onCopyCells}
            onResult={props.onResult}
            onStepResult={props.onStepResult}
          />
        </Show>
      </div>
    </div>
  );
}

/**
 * 結果の場所の「データ」の側：SQL を実行した結果（実行中・取り消し・間違い・結果の表）と、その下の件数・ページ送り。
 * 文を 2 つ以上実行したときは、上に文ごとの結果のタブを出し、選んだ文の結果を出す（#380）。
 */
function DataView(props: {
  run: DbRun;
  mac: boolean;
  onPage: (step: PageStep) => void;
  onSort: (column: number) => void;
  onCopyCells: (text: string) => void;
  onResult: (index: number) => void;
  onStepResult: (step: 1 | -1) => void;
}): JSX.Element {
  /** 出している文の結果（まだ実行していなければ undefined） */
  const stmt = () => activeStatement(props.run);
  /** 出している文を実行している（ほかの文を実行している間は、その文の結果を出したまま、ページ送りと並べ替えを止める） */
  const running = () => activeRunning(props.run);
  /** このタブで何かを実行している */
  const busy = () => props.run.running !== undefined;
  /** 出している文の間違い（取り消しは除く） */
  const error = () => {
    const f = stmt()?.failure;
    return f?.kind === "error" ? f : undefined;
  };
  /** 結果の表か結果のタブの列で押した `[` `]`（タブの列では ← → も）で、結果のタブを切り替える */
  function keydown(e: KeyboardEvent) {
    if (props.run.statements.length < 2) return;
    const target = e.target as HTMLElement;
    const onTabs = target.closest("[role=tablist]") !== null;
    const step = dbResultTabKey(e, onTabs);
    if (step === 0) return;
    e.preventDefault();
    props.onStepResult(step);
    // タブの列でキーを押したら、キーを選んだタブに移す（WAI-ARIA のタブの動き）。表で押して、次の文の結果に
    // 表が無い（エラー・行が無い）ときも、キーを失わないよう選んだタブに移す
    const root = e.currentTarget as HTMLElement;
    queueMicrotask(() => {
      if (onTabs || !target.isConnected)
        root
          .querySelector<HTMLElement>('[role=tab][aria-selected="true"]')
          ?.focus();
    });
  }
  return (
    <div class={styles.data} data-place="dbResult" onKeyDown={keydown}>
      <Show when={props.run.statements.length > 1}>
        <div
          class={styles.results}
          role="tablist"
          aria-label={T("db.view.results")}
        >
          <For each={props.run.statements}>
            {(s, i) => (
              <button
                type="button"
                role="tab"
                class={styles.viewTab}
                data-failed={s.failure?.kind === "error" ? "" : undefined}
                aria-selected={props.run.active === i() ? "true" : "false"}
                tabindex={props.run.active === i() ? 0 : -1}
                title={s.sql}
                onClick={() => props.onResult(i())}
              >
                {T("db.view.resultTab", {
                  n: String(i() + 1),
                  sql: resultTabLabel(s.sql),
                })}
              </button>
            )}
          </For>
        </div>
      </Show>
      <div
        class={styles.result}
        role="region"
        aria-label={T("db.view.result")}
        aria-busy={running() ? "true" : undefined}
      >
        <Switch fallback={<p class={styles.note}>{T("db.view.empty")}</p>}>
          <Match when={running()}>
            <p class={styles.note}>{T("db.view.running")}</p>
          </Match>
          <Match when={stmt()?.failure?.kind === "cancelled"}>
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
          <Match when={stmt()?.result}>
            {(r) => (
              <ResultTable
                result={r()}
                mac={props.mac}
                onCopy={props.onCopyCells}
                sort={stmt()?.page?.sort}
                onSort={busy() || !sortable(r()) ? undefined : props.onSort}
              />
            )}
          </Match>
        </Switch>
      </div>
      <Show when={stmt()?.result}>
        {(r) => (
          <div class={styles.status}>
            <span role="status">{running() ? "" : resultSummary(r())}</span>
            {/* ページ送り（#373）。包める文で 2 ページ以上あるときだけ出す。実行している間は押せない */}
            <Show
              when={stmt()?.page && pageable(r()) ? stmt()?.page : undefined}
            >
              {(page) => (
                <div
                  class={styles.pager}
                  role="group"
                  aria-label={T("db.view.pages")}
                >
                  <Button
                    disabled={busy() || !canStep(r(), page(), "prev")}
                    onClick={() => props.onPage("prev")}
                  >
                    {T("db.view.prevPage")}
                  </Button>
                  <Button
                    disabled={busy() || !canStep(r(), page(), "next")}
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
                      const pos = (): CellPos => ({ row: r(), col: i() });
                      return (
                        <Cell
                          value={v}
                          kind={props.result.columns[i()]?.kind}
                          selected={inRange(range(), pos())}
                          onPointerDown={(e) => down(e, pos())}
                          onPointerEnter={(e) => enter(e, pos())}
                        />
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

/**
 * 結果の場所の上の切り替え（#379）：「データ」（SQL を実行した結果）と「Structure」（木で選んだテーブルの構造）。
 * 左右のキーでも移れる。リーダーの d s でも切り替えられる。
 */
function ViewSwitch(props: {
  view: DbResultView;
  /** 選んだテーブル（"schema.table"。読み上げとツールチップ） */
  table: string;
  onView: (view: DbResultView) => void;
}): JSX.Element {
  const views: { view: DbResultView; label: () => string }[] = [
    { view: "data", label: () => T("db.view.data") },
    { view: "structure", label: () => T("db.view.structure") },
  ];
  function keydown(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next: DbResultView = e.key === "ArrowLeft" ? "data" : "structure";
    props.onView(next);
    (e.currentTarget as HTMLElement)
      .querySelector<HTMLElement>(`[data-view="${next}"]`)
      ?.focus();
  }
  return (
    <div
      class={styles.views}
      role="tablist"
      aria-label={T("db.view.switch")}
      title={props.table}
      onKeyDown={keydown}
    >
      <For each={views}>
        {(v) => (
          <button
            type="button"
            role="tab"
            class={styles.viewTab}
            data-view={v.view}
            aria-selected={props.view === v.view ? "true" : "false"}
            tabindex={props.view === v.view ? 0 : -1}
            onClick={() => props.onView(v.view)}
          >
            {v.label()}
          </button>
        )}
      </For>
      <span class={styles.viewTable}>{props.table}</span>
    </div>
  );
}

/** 木で選んだテーブルの構造（#379）：列・インデックス・外部キーの 3 つの表。 */
function StructureView(props: { state: DbStructureState }): JSX.Element {
  const table = () => `${props.state.table.schema}.${props.state.table.table}`;
  return (
    <div
      class={styles.result}
      role="tabpanel"
      aria-label={T("db.structure.label", { table: table() })}
      aria-busy={props.state.loading ? "true" : undefined}
    >
      <Switch>
        <Match when={props.state.loading}>
          <p class={styles.note}>{T("db.structure.loading")}</p>
        </Match>
        <Match when={props.state.error}>
          {(err) => (
            <div class={styles.error} role="alert">
              <pre class={styles.message}>{err()}</pre>
            </div>
          )}
        </Match>
        <Match when={props.state.structure}>
          {(s) => (
            <StructureTables
              structure={s()}
              schema={props.state.table.schema}
            />
          )}
        </Match>
      </Switch>
    </div>
  );
}

/** 構造の 3 つの表。値は 1 行で、はみ出す分は「…」（全部はツールチップ）。 */
function StructureTables(props: {
  structure: DbStructure;
  schema: string;
}): JSX.Element {
  const words = () => ({
    primary: T("db.structure.primary"),
    unique: T("db.structure.unique"),
  });
  return (
    <>
      <Show when={props.structure.truncated}>
        <p class={styles.note}>{T("db.structure.truncated")}</p>
      </Show>
      <Section
        title={T("db.structure.columns")}
        heads={[
          T("db.structure.name"),
          T("db.structure.type"),
          T("db.structure.nullable"),
          T("db.structure.default"),
        ]}
        rows={props.structure.columns.map((c) => [
          c.name,
          c.type,
          c.nullable ? T("db.structure.yes") : T("db.structure.no"),
          c.default,
        ])}
      />
      <Section
        title={T("db.structure.indexes")}
        heads={[
          T("db.structure.name"),
          T("db.structure.keys"),
          T("db.structure.kind"),
          T("db.structure.method"),
        ]}
        rows={props.structure.indexes.map((ix) => [
          ix.name,
          keyColumnsText(ix.columns),
          indexKindText(ix, words()),
          ix.method,
        ])}
      />
      <Section
        title={T("db.structure.foreignKeys")}
        heads={[
          T("db.structure.name"),
          T("db.structure.keys"),
          T("db.structure.references"),
          T("db.structure.onUpdate"),
          T("db.structure.onDelete"),
        ]}
        rows={props.structure.foreignKeys.map((fk) => [
          fk.name,
          keyColumnsText(fk.columns),
          referenceText(fk, props.schema),
          fk.onUpdate,
          fk.onDelete,
        ])}
      />
    </>
  );
}

/** 構造の表の 1 つ（見出しと行）。null のセルは NULL の印で出す。 */
function Section(props: {
  title: string;
  heads: string[];
  rows: (string | null)[][];
}): JSX.Element {
  return (
    <section class={styles.section} aria-label={props.title}>
      <h3 class={styles.sectionTitle}>{props.title}</h3>
      <Show
        when={props.rows.length > 0}
        fallback={<p class={styles.note}>{T("db.structure.none")}</p>}
      >
        <table class={styles.table}>
          <thead>
            <tr>
              <For each={props.heads}>
                {(h) => <th class={styles.th}>{h}</th>}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={props.rows}>
              {(row) => (
                <tr>
                  <For each={row}>{(v) => <Cell value={v} />}</For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </section>
  );
}

/**
 * 表のセル 1 つ（結果の表と構造の表で同じ）。長い値は切り（全部はツールチップ）、改行とタブは印にし、NULL は印で出す。
 */
function Cell(props: {
  value: string | null;
  /** 列の種類（数の列は右に寄せる） */
  kind?: string;
  selected?: boolean;
  onPointerDown?: (e: PointerEvent) => void;
  onPointerEnter?: (e: PointerEvent) => void;
}): JSX.Element {
  const text = () => cellText(props.value);
  return (
    <td
      class={styles.cell}
      data-kind={props.kind}
      data-null={text() === null ? "" : undefined}
      data-selected={props.selected ? "" : undefined}
      title={
        props.value !== null && props.value !== text() ? props.value : undefined
      }
      onPointerDown={(e) => props.onPointerDown?.(e)}
      onPointerEnter={(e) => props.onPointerEnter?.(e)}
    >
      {text() ?? "NULL"}
    </td>
  );
}
