// DB のタブ（#347）を出している間に、サイドバーのファイルツリーの場所に出す、そのタブの接続の木。
// 上の 1 行に、その接続の既定のスキーマの欄（押すと、その場所に選ぶ一覧が開く。#378・#398）と、読み直すボタンを並べる。
// 木には、そのスキーマのテーブル（ビューを含む）だけを並べる（列はテーブルの Structure で見る）。示すスキーマが無いときだけ、
// スキーマ → テーブル の 2 段を出す。2 行目の入力欄に打った字でテーブルを名前で絞り込み、ほかのスキーマの合うテーブルも後ろに出す。
// 一覧（db.schema の答え）・開けている枝・接続ごとに覚えるものは features/db/controller.ts が持つ。ここは出すことと、木の中のキー・クリックだけ。
// キーの判定は features/db/keys.ts の dbTreeKey、行き先は features/db/tree.ts の treeStep、
// 既定のスキーマを選ぶ一覧の中身と、木に出すスキーマは features/db/schemaPrefs.ts。
import { T } from "../../../../i18n/index.ts";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  Show,
  type JSX,
} from "solid-js";

import type { DbCatalogState } from "../../../../features/db/treeController.ts";
import { dbTreeFilterKey, dbTreeKey } from "../../../../features/db/keys.ts";
import {
  onlySchema,
  schemaChoices,
} from "../../../../features/db/schemaPrefs.ts";
import {
  treeStep,
  visibleRows,
  type TreeRow,
  type TreeStep,
} from "../../../../features/db/tree.ts";
import { Kbd } from "../../../components/KeyHints.tsx";
import { DbSchemaPicker, schemaOptionLabel } from "./DbSchemaPicker.tsx";
import styles from "./DbTree.module.css";

/** サイドバーの木が外から受け取る値と、外へ頼むこと。 */
export interface DbTreeProps {
  catalog: DbCatalogState;
  /** 開けている枝（tree.ts の行の id） */
  expanded: ReadonlySet<string>;
  onToggle: (node: string, open: boolean) => void;
  /** テーブル（ビュー）を選んだ：その中身を見る */
  onPreview: (schema: string, table: string) => void;
  /** その接続で選んだ既定のスキーマ（#378。選んでいなければ undefined：欄は DB の既定を示す） */
  chosenSchema: string | undefined;
  /** 既定のスキーマを選んだ：その接続の既定のスキーマにする（null は「DB の既定」） */
  onSchema: (option: string | null) => void;
  onReload: () => void;
  /** キーを SQL の入力欄に戻す */
  onLeave: () => void;
}

/** サイドバーの、DB のタブの接続の木。キーを向ける先は data-place="dbTree" の要素（ui/main-window/focus.ts が探す）。 */
export function DbTree(props: DbTreeProps): JSX.Element {
  let list: HTMLDivElement | undefined;
  let treeEl: HTMLDivElement | undefined;
  let filterEl: HTMLInputElement | undefined;
  const [cursor, setCursor] = createSignal<string | undefined>();
  /** テーブル名の絞り込み（タブを出し直すと空に戻る。開けている枝は変えない） */
  const [filter, setFilter] = createSignal("");
  /** 既定のスキーマの選択肢と、今選ばれているもの（一覧がまだ無ければ undefined） */
  const choices = createMemo(() =>
    props.catalog.catalog
      ? schemaChoices(props.catalog.catalog, props.chosenSchema)
      : undefined,
  );
  const rows = createMemo(() => {
    const c = props.catalog.catalog;
    if (!c) return [];
    return visibleRows(
      c,
      props.expanded,
      filter(),
      onlySchema(c, props.chosenSchema),
    );
  });
  const activeIndex = () => rows().findIndex((r) => r.id === cursor());
  // 選んでいる行が、閉じた枝の中に隠れた・一覧が替わって無くなったら、先頭に戻す
  createEffect(
    on(rows, (r) => {
      const c = cursor();
      if (c !== undefined && !r.some((x) => x.id === c)) setCursor(r[0]?.id);
    }),
  );
  // 選んでいる行が見える所までスクロールする
  createEffect(() => {
    const c = cursor();
    if (c === undefined) return;
    const el = [
      ...(list?.querySelectorAll<HTMLElement>("[data-id]") ?? []),
    ].find((e) => e.dataset.id === c);
    el?.scrollIntoView?.({ block: "nearest" });
  });

  /** treeStep の結果のうち、行を動かす以外のこと（開け閉め・中身を見る）を行う。 */
  function apply(s: TreeStep) {
    if (s.toggle) props.onToggle(s.toggle.id, s.toggle.open);
    if (s.preview) props.onPreview(s.preview.schema, s.preview.table);
  }

  function enter(r: TreeRow) {
    apply(treeStep(rows(), r.id, "enter"));
  }

  function onKeyDown(e: KeyboardEvent) {
    // 木そのものにキーがあるときだけ受ける（中の「読み直す」ボタンの Enter などを奪わない。行はキーを持たない）
    if (e.target !== e.currentTarget) return;
    const a = dbTreeKey(e);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const s = treeStep(rows(), cursor(), a);
    if (s.leave) props.onLeave();
    if (s.focusFilter) filterEl?.focus();
    if (s.focusSchema) openPicker();
    if (s.cursor !== undefined) setCursor(s.cursor);
    apply(s);
  }

  /** 絞り込みの入力欄のキー：Enter・Esc・↓ で木に戻す（絞り込みは残す） */
  function onFilterKeyDown(e: KeyboardEvent) {
    if (dbTreeFilterKey(e) !== "tree") return;
    backToTree(e);
  }

  function backToTree(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (cursor() === undefined) setCursor(rows()[0]?.id);
    treeEl?.focus();
  }

  /** 既定のスキーマを選ぶ所（欄の場所に出す一覧）を開いているか */
  const [picking, setPicking] = createSignal(false);
  function openPicker() {
    if (choices()) setPicking(true);
  }
  /** 閉じる。キーが選ぶ所の中にあったら（フォーカスが外れて閉じたのでなければ）、木に戻す */
  function closePicker() {
    const inside = treeEl?.contains(document.activeElement) ?? false;
    setPicking(false);
    if (inside) {
      if (cursor() === undefined) setCursor(rows()[0]?.id);
      treeEl?.focus();
    }
  }

  return (
    <div
      ref={treeEl}
      class={styles.tree}
      role="group"
      aria-label={T("db.tree.label")}
      tabindex="0"
      aria-activedescendant={
        activeIndex() >= 0 ? `dbtree-${activeIndex()}` : undefined
      }
      data-place="dbTree"
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (cursor() === undefined) setCursor(rows()[0]?.id);
      }}
    >
      <div class={styles.bar}>
        <Show
          when={picking() && choices()}
          fallback={
            <button
              type="button"
              class={`${styles.field} ${styles.schemaButton}`}
              title={T("db.tree.schema.hint")}
              aria-haspopup="listbox"
              aria-label={T("db.tree.schema.label")}
              disabled={!choices()}
              onClick={openPicker}
            >
              <span class={styles.schemaName}>
                {choices()
                  ? schemaOptionLabel(choices()!.selected)
                  : T("db.tree.loading")}
              </span>
              <span class={styles.schemaArrow} aria-hidden="true">
                ▾
              </span>
            </button>
          }
        >
          {(c) => (
            <DbSchemaPicker
              options={c().options}
              selected={c().selected}
              onChoose={(o) => {
                closePicker();
                props.onSchema(o);
              }}
              onCancel={closePicker}
            />
          )}
        </Show>
        {/* 読み直すボタンは、選ぶ一覧を開いている間も同じ場所に残す（消えたり出たりしてちらつかないように） */}
        <button
          type="button"
          class={styles.iconButton}
          title={T("db.tree.reload")}
          aria-label={T("db.tree.reload")}
          aria-busy={props.catalog.loading ? "true" : undefined}
          disabled={!!props.catalog.loading}
          onClick={props.onReload}
        >
          ↻
        </button>
      </div>
      <div class={styles.filterBox}>
        <input
          ref={filterEl}
          class={`${styles.field} ${styles.filter}`}
          type="search"
          placeholder={T("db.tree.filter.placeholder")}
          aria-label={T("db.tree.filter.label")}
          autocomplete="off"
          spellcheck={false}
          // value は渡さない：打つたびに value を入れ直すと、WebKit でかな漢字変換中の字が重なって増える
          onInput={(e) => setFilter(e.currentTarget.value)}
          onKeyDown={onFilterKeyDown}
        />
        <span class={styles.filterKey} aria-hidden="true">
          <Kbd>/</Kbd>
        </span>
      </div>
      <Show when={props.catalog.error}>
        {(m) => (
          <p class={styles.error} role="alert">
            {m()}
          </p>
        )}
      </Show>
      <Show when={props.catalog.catalog}>
        {(c) => (
          <>
            <Show when={c().schemas.length === 0}>
              <p class={styles.note}>{T("db.tree.empty")}</p>
            </Show>
            <Show when={filter().trim() !== "" && rows().length === 0}>
              <p class={styles.note}>{T("db.tree.noMatch")}</p>
            </Show>
            <Show
              when={
                filter().trim() === "" &&
                rows().length === 0 &&
                c().schemas.length > 0
              }
            >
              <p class={styles.note}>{T("db.tree.noTables")}</p>
            </Show>
            <div
              ref={list}
              class={styles.list}
              role="tree"
              aria-label={T("db.tree.label")}
              aria-busy={props.catalog.loading ? "true" : undefined}
            >
              <For each={rows()}>
                {(r, i) => (
                  <>
                    <Show when={r.other && !rows()[i() - 1]?.other}>
                      <p class={styles.otherHead}>
                        {T("db.tree.otherSchemas")}
                      </p>
                    </Show>
                    <div
                      id={`dbtree-${i()}`}
                      class={styles.row}
                      role="treeitem"
                      aria-level={r.depth + 1}
                      aria-expanded={r.expandable ? r.expanded : undefined}
                      aria-selected={cursor() === r.id}
                      data-id={r.id}
                      data-kind={r.kind}
                      style={{ "padding-left": `${r.depth * 14 + 6}px` }}
                      title={r.label}
                      onClick={() => {
                        setCursor(r.id);
                        enter(r);
                      }}
                    >
                      <span
                        class={styles.twist}
                        aria-hidden="true"
                        onClick={(e) => {
                          if (!r.expandable) return;
                          e.stopPropagation();
                          setCursor(r.id);
                          props.onToggle(r.id, !r.expanded);
                        }}
                      >
                        {r.expandable ? (r.expanded ? "▾" : "▸") : ""}
                      </span>
                      <span class={styles.label}>{r.label}</span>
                      <Show
                        when={
                          r.kind === "schema" &&
                          r.schema === choices()?.selected
                        }
                      >
                        <span class={styles.badge} data-default>
                          {T("db.tree.defaultBadge")}
                        </span>
                      </Show>
                      <Show when={r.kind === "view"}>
                        <span class={styles.badge}>{T("db.tree.view")}</span>
                      </Show>
                    </div>
                  </>
                )}
              </For>
            </div>
            <Show when={c().truncated}>
              <p class={styles.note}>{T("db.tree.truncated")}</p>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
