// DB のタブ（#347）を出している間に、右のペインに出す画面。グリッドの場所すべてを覆う（ブラウザのページ・空のワークスペースの画面と同じ）。
// 上に SQL の入力欄、その下に結果のタブの列（#404）、結果の表、件数とかかった時間を出す。
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

import type {
  DbResultTab,
  DbRun,
  RunInto,
} from "../../../../features/db/controller.ts";
import {
  dbEditorKey,
  dbResultKey,
  dbResultTabKey,
} from "../../../../features/db/keys.ts";
import {
  activeRunning,
  activeTab,
  resultTabLabel,
} from "../../../../features/db/results.ts";
import { cellText, resultSummary } from "../../../../features/db/model.ts";
import {
  ariaSort,
  canStep,
  pageable,
  sortable,
  type DbPage,
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
  /**
   * 実行する。入力欄の字と、選んでいる範囲（選んでいなければ、どちらもカーソルの位置）を渡す。何を実行するかは features/db/ が決める（#375）。
   * into は結果を出す先（active：出している結果のタブに上書き、new：新しい結果のタブ。#404）
   */
  onRun: (
    text: string,
    selStart: number,
    selEnd: number,
    into: RunInto,
  ) => void;
  /** 結果のページを切り替える（#373） */
  onPage: (step: PageStep) => void;
  /** 列 column（0 から数える）で並べ替える（#377）。押すたびに昇順 → 降順 → 並べ替えなし */
  onSort: (column: number) => void;
  onCancel: () => void;
  /** 結果の表で選んだセルをコピーする（#372） */
  onCopyCells: (text: string) => void;
  /** 結果のタブ（#404）：タブ tab を出す・step だけ動かす・タブ tab を閉じる */
  onResult: (tab: string) => void;
  onStepResult: (step: 1 | -1) => void;
  onCloseResult: (tab: string) => void;
  /** 出している結果のタブのテーブル（木で選んだもの）と、その構造・結果の場所に出している側（#379）。テーブルが無ければ undefined（切り替えを出さない） */
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

  /** 入力欄で選んでいる部分か、選んでいなければカーソルのある文を実行する（#375）。結果は into の先に出す（#404） */
  function runSelected(into: RunInto = "active") {
    props.onRun(input.value, input.selectionStart, input.selectionEnd, into);
  }

  function onKeyDown(e: KeyboardEvent) {
    const a = dbEditorKey(e, props.mac);
    if (!a) return;
    if (a === "cancel" && !props.run.running) return;
    e.preventDefault();
    e.stopPropagation();
    if (a === "cancel") props.onCancel();
    else runSelected(a === "runNew" ? "new" : "active");
  }

  /** 結果の場所に出している側（#379）。出している結果のタブにテーブルが無ければ、いつもデータ */
  const view = (): DbResultView => props.structure?.view ?? "data";

  /** 結果の場所（結果のタブの列・切り替え・表）で押した `[` `]` で、結果のタブを切り替える（タブの列で押したものは ResultTabs が受ける） */
  function resultKeydown(e: KeyboardEvent) {
    if (props.run.tabs.length < 2) return;
    const step = dbResultTabKey(e, false);
    if (step === 0) return;
    e.preventDefault();
    props.onStepResult(step);
    // 次のタブに、キーのあった所が無い（表が無い：エラー・行が無い、切り替えが無い）ときは、キーを失わないよう選んだタブに移す
    const target = e.target as HTMLElement;
    const root = e.currentTarget as HTMLElement;
    queueMicrotask(() => {
      if (!target.isConnected) focusSelectedTab(root);
    });
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
                onClick={() => runSelected()}
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
          class={styles.data}
          data-place="dbResult"
          onKeyDown={resultKeydown}
        >
          <Show when={props.run.tabs.length > 0}>
            <ResultTabs
              run={props.run}
              onResult={props.onResult}
              onStepResult={props.onStepResult}
              onClose={props.onCloseResult}
              focusInput={() => input.focus()}
            />
          </Show>
          {/* 結果の場所の切り替え（#379）。出している結果のタブが、木でテーブルを選んで出したものなら出す */}
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
            />
          </Show>
        </div>
      </div>
    </div>
  );
}

/**
 * 結果の場所の「データ」の側：出している結果のタブ（#404）の、SQL を実行した結果（実行中・取り消し・間違い・結果の表）と、
 * その下の件数・ページ送り。
 */
function DataView(props: {
  run: DbRun;
  mac: boolean;
  onPage: (step: PageStep) => void;
  onSort: (column: number) => void;
  onCopyCells: (text: string) => void;
}): JSX.Element {
  /** 出している結果のタブ（まだ実行していなければ undefined） */
  const tab = () => activeTab(props.run);
  /** 出しているタブの文を実行している（ほかのタブの文を実行している間は、出しているタブの結果を出したまま、ページ送りと並べ替えを止める） */
  const running = () => activeRunning(props.run);
  /** この DB のタブで何かを実行している */
  const busy = () => props.run.running !== undefined;
  /** 出しているタブの文の間違い（取り消しは除く） */
  const error = () => {
    const f = tab()?.failure;
    return f?.kind === "error" ? f : undefined;
  };
  return (
    <>
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
          <Match when={tab()?.failure?.kind === "cancelled"}>
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
          <Match when={tab()?.result}>
            {(r) => (
              <ResultTable
                result={r()}
                mac={props.mac}
                onCopy={props.onCopyCells}
                sort={tab()?.page?.sort}
                onSort={busy() || !sortable(r()) ? undefined : props.onSort}
                tab={props.run.active}
              />
            )}
          </Match>
        </Switch>
      </div>
      <Show when={tab()?.result}>
        {(r) => (
          <ResultStatus
            result={r()}
            page={tab()?.page}
            running={running()}
            busy={busy()}
            onPage={props.onPage}
          />
        )}
      </Show>
    </>
  );
}

/** 結果のタブの列で、選んでいるタブにキーを向ける。タブが無ければ false。 */
function focusSelectedTab(root: HTMLElement): boolean {
  const tab = root.querySelector<HTMLElement>(
    '[role=tab][aria-selected="true"]',
  );
  tab?.focus();
  return tab !== null;
}

/**
 * 結果のタブの列（#404）。タブ 1 つ（ResultTab）が、実行した文 1 つとその結果。多ければ、この列だけが横にスクロールする。
 * 列にキーがあるときは、`[` `]` と `←` `→` で切り替え、キーを選んだタブに移す（WAI-ARIA のタブの動き。ViewSwitch と同じ）。
 */
function ResultTabs(props: {
  run: DbRun;
  onResult: (tab: string) => void;
  onStepResult: (step: 1 | -1) => void;
  onClose: (tab: string) => void;
  /** SQL の入力欄にキーを向ける（最後のタブを閉じて、キーを置く所が無くなったとき） */
  focusInput: () => void;
}): JSX.Element {
  let list!: HTMLDivElement;
  function keydown(e: KeyboardEvent) {
    const step = dbResultTabKey(e, true);
    if (step === 0) return;
    e.preventDefault();
    // 結果の場所のキー（DbTabView の resultKeydown）に、もう一度受けさせない
    e.stopPropagation();
    props.onStepResult(step);
    queueMicrotask(() => focusSelectedTab(list));
  }
  /** タブを閉じる。キーが閉じたタブにあったなら、選んだタブ（無ければ SQL の入力欄）に移す */
  function close(tab: string) {
    props.onClose(tab);
    queueMicrotask(() => {
      const at = document.activeElement;
      if (at && at !== document.body && at.isConnected) return;
      if (!list.isConnected || !focusSelectedTab(list)) props.focusInput();
    });
  }
  // 出しているタブが替わったら、列の見える所に入れる
  createEffect(() => {
    void props.run.active;
    queueMicrotask(() =>
      list
        .querySelector('[role=tab][aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" }),
    );
  });
  return (
    <div
      ref={list}
      class={styles.results}
      role="tablist"
      aria-label={T("db.view.results")}
      onKeyDown={keydown}
    >
      {/* 行は、タブの id で見分ける。タブの中身（結果・ページ）は届くたびに作り直されるので、中身で見分けると、
          そのたびにタブの DOM が作り直され、タブの見出しにあったキーが場所を失う */}
      <For each={props.run.tabs.map((t) => t.id)}>
        {(id) => (
          <Show when={props.run.tabs.find((t) => t.id === id)}>
            {(t) => (
              <ResultTab
                tab={t()}
                selected={props.run.active === id}
                running={props.run.running?.tab === id}
                onShow={() => props.onResult(id)}
                onClose={() => close(id)}
              />
            )}
          </Show>
        )}
      </For>
    </div>
  );
}

/**
 * 結果のタブ 1 つ（#404）：見出しのボタンと、閉じる ×。見出しは文の先頭（全部はツールチップ）で、失敗した文は赤い字、
 * 実行している文は斜体。× か、マウスの中ボタンで閉じる。
 */
function ResultTab(props: {
  tab: DbResultTab;
  /** 結果の場所に出しているタブか */
  selected: boolean;
  /** このタブの文を実行しているか */
  running: boolean;
  onShow: () => void;
  onClose: () => void;
}): JSX.Element {
  const label = () => resultTabLabel(props.tab.sql);
  return (
    <div
      class={styles.resultTab}
      role="presentation"
      data-selected={props.selected ? "" : undefined}
      data-failed={props.tab.failure?.kind === "error" ? "" : undefined}
      data-running={props.running ? "" : undefined}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        props.onClose();
      }}
    >
      <button
        type="button"
        role="tab"
        class={styles.resultLabel}
        aria-selected={props.selected ? "true" : "false"}
        tabindex={props.selected ? 0 : -1}
        title={props.tab.sql}
        onClick={props.onShow}
      >
        {label()}
      </button>
      <button
        type="button"
        class={styles.resultClose}
        tabindex={-1}
        aria-label={T("db.view.closeResult", { sql: label() })}
        onClick={props.onClose}
      >
        ×
      </button>
    </div>
  );
}

/** 結果の表の下の、件数とかかった時間と、ページ送り（#373。包める文で 2 ページ以上あるときだけ）。 */
function ResultStatus(props: {
  result: DbQueryResult;
  page: DbPage | undefined;
  /** 出している文を実行している（件数を出さない） */
  running: boolean;
  /** このタブで何かを実行している（ページ送りを押せない） */
  busy: boolean;
  onPage: (step: PageStep) => void;
}): JSX.Element {
  return (
    <div class={styles.status}>
      <span role="status">
        {props.running ? "" : resultSummary(props.result)}
      </span>
      <Show
        when={props.page && pageable(props.result) ? props.page : undefined}
      >
        {(page) => (
          <div
            class={styles.pager}
            role="group"
            aria-label={T("db.view.pages")}
          >
            <Button
              disabled={props.busy || !canStep(props.result, page(), "prev")}
              onClick={() => props.onPage("prev")}
            >
              {T("db.view.prevPage")}
            </Button>
            <Button
              disabled={props.busy || !canStep(props.result, page(), "next")}
              onClick={() => props.onPage("next")}
            >
              {T("db.view.nextPage")}
            </Button>
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
  /** 出している結果のタブ（#404）。替わったら、別の文の結果なので選びを外す */
  tab: string | undefined;
}): JSX.Element {
  const [range, setRange] = createSignal<CellRange | null>(null);
  let dragging = false;
  // 同じタブの結果が入れ替わったら（ページ送り・並べ替え）、選びを表の大きさに収める（収まるセルが無ければ外す）。
  // 別のタブの結果に替わったら、前のタブで選んだ位置を持ち越さない
  let shown = props.tab;
  createEffect(() => {
    const r = props.result;
    const s = props.tab;
    const same = s === shown;
    shown = s;
    setRange((cur) => (same ? clampRange(cur, r) : null));
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
