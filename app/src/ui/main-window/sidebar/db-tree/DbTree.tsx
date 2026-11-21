// DB のタブ（#347）を出している間に、サイドバーのファイルツリーの場所に出す、そのタブの接続の木。
// スキーマ → テーブル（ビューを含む）の 2 段を出す（列はテーブルの Structure で見る）。上の入力欄に打った字で、テーブル名を絞り込める。スキーマを選ぶと、そのタブの既定のスキーマになる（#378）。
// 一覧（db.schema の答え）と、開けている枝は features/db/controller.ts が持つ。ここは出すことと、木の中のキー・クリックだけ。
// キーの判定は features/db/keys.ts の dbTreeKey、行き先は features/db/tree.ts の treeStep。
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
  treeStep,
  visibleRows,
  type TreeRow,
  type TreeStep,
} from "../../../../features/db/tree.ts";
import { Button } from "../../../components/Button.tsx";
import { Input } from "../../../components/Field.tsx";
import styles from "./DbTree.module.css";

/** サイドバーの木が外から受け取る値と、外へ頼むこと。 */
export interface DbTreeProps {
  catalog: DbCatalogState;
  /** 開けている枝（tree.ts の行の id） */
  expanded: ReadonlySet<string>;
  onToggle: (node: string, open: boolean) => void;
  /** テーブル（ビュー）を選んだ：その中身を見る */
  onPreview: (schema: string, table: string) => void;
  /** タブの既定のスキーマ（#378。選んでいなければ undefined） */
  defaultSchema: string | undefined;
  /** スキーマを選んだ：タブの既定のスキーマにする（null なら、やめて DB の既定に戻す） */
  onDefaultSchema: (schema: string | null) => void;
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
  const rows = createMemo(() =>
    props.catalog.catalog
      ? visibleRows(props.catalog.catalog, props.expanded, filter())
      : [],
  );
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

  /** treeStep の結果のうち、行を動かす以外のこと（開け閉め・中身を見る・既定のスキーマ）を行う。 */
  function apply(s: TreeStep) {
    if (s.toggle) props.onToggle(s.toggle.id, s.toggle.open);
    if (s.preview) props.onPreview(s.preview.schema, s.preview.table);
    if (s.setDefaultSchema !== undefined)
      props.onDefaultSchema(s.setDefaultSchema);
  }

  function enter(r: TreeRow) {
    apply(treeStep(rows(), r.id, "enter", props.defaultSchema));
  }

  function onKeyDown(e: KeyboardEvent) {
    // 木そのものにキーがあるときだけ受ける（中の「読み直す」ボタンの Enter などを奪わない。行はキーを持たない）
    if (e.target !== e.currentTarget) return;
    const a = dbTreeKey(e);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const s = treeStep(rows(), cursor(), a, props.defaultSchema);
    if (s.leave) props.onLeave();
    if (s.focusFilter) filterEl?.focus();
    if (s.cursor !== undefined) setCursor(s.cursor);
    apply(s);
  }

  /** 絞り込みの入力欄のキー：Enter・Esc・↓ で木に戻す（絞り込みは残す） */
  function onFilterKeyDown(e: KeyboardEvent) {
    if (dbTreeFilterKey(e) !== "tree") return;
    e.preventDefault();
    e.stopPropagation();
    if (cursor() === undefined) setCursor(rows()[0]?.id);
    treeEl?.focus();
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
      <div class={styles.head}>
        <span class={styles.title}>{T("db.tree.title")}</span>
        <Button busy={!!props.catalog.loading} onClick={props.onReload}>
          {T("db.tree.reload")}
        </Button>
      </div>
      <Input
        ref={filterEl}
        class={styles.filter}
        type="search"
        value={filter()}
        placeholder={T("db.tree.filter.placeholder")}
        aria-label={T("db.tree.filter.label")}
        autocomplete="off"
        spellcheck={false}
        onInput={(e) => setFilter(e.currentTarget.value)}
        onKeyDown={onFilterKeyDown}
      />
      <Show when={props.defaultSchema}>
        {(s) => (
          <div class={styles.defaultSchema} data-default-schema>
            <p class={styles.note}>
              {T("db.tree.defaultSchema", { schema: s() })}
            </p>
            <Button onClick={() => props.onDefaultSchema(null)}>
              {T("db.tree.clearDefault")}
            </Button>
          </div>
        )}
      </Show>
      <Show when={props.catalog.error}>
        {(m) => (
          <p class={styles.error} role="alert">
            {m()}
          </p>
        )}
      </Show>
      <Show when={!props.catalog.catalog && props.catalog.loading}>
        <p class={styles.note}>{T("db.tree.loading")}</p>
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
            <div
              ref={list}
              class={styles.list}
              role="tree"
              aria-label={T("db.tree.label")}
              aria-busy={props.catalog.loading ? "true" : undefined}
            >
              <For each={rows()}>
                {(r, i) => (
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
                        r.kind === "schema" && r.schema === props.defaultSchema
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
