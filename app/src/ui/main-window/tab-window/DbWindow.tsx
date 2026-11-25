import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  untrack,
  type JSX,
} from "solid-js";

import type { DbTabs } from "../../../features/db/controller.ts";
import { isExportable } from "../../../features/db/export.ts";
import { EMPTY_RUN, type DbRun } from "../../../features/db/results.ts";
import {
  dbWindowRows,
  selectedResult,
  stepResult,
  type DbWindowRow,
} from "../../../features/db/window.ts";
import { dbLabel } from "../../../features/workspaces/model.ts";
import { T } from "../../../i18n/index.ts";
import "../../components/card.css";
import {
  CardBody,
  CardText,
  CardTitle,
  ModalCard,
} from "../../components/Card.tsx";
import { KeyFooter, type ActionGroup } from "../../components/KeyFooter.tsx";
import { openKeyList } from "../commands/KeyListDialog.tsx";
import { dbWindowKey } from "./dbWindowKey.ts";
import styles from "./DbWindow.module.css";

const rowId = (id: string) => `db-window-result-${id}`;

/** 行の状態の字。 */
function stateText(s: DbWindowRow["state"]): string {
  switch (s.kind) {
    case "running":
      return T("dbWindow.state.running");
    case "cancelled":
      return T("dbWindow.state.cancelled");
    case "error":
      return s.sqlState
        ? T("dbWindow.state.errorCode", { code: s.sqlState })
        : T("dbWindow.state.error");
    case "done":
      return s.summary;
    case "none":
      return T("dbWindow.state.none");
  }
}

/**
 * DB のタブの窓（リーダーの `a`。#458）。開いたときに出していた DB のタブ 1 つの状態（接続・マシン・つながり・実行中・強めている権限・木）と、
 * そのタブの結果のタブ（#404）の一覧を出し、結果のタブを 1 つ選んで操作する（出す・閉じる・データと Structure・ページ・書き出す）。
 * タブ全体への操作（取り消す・木にキーを向ける・木を読み直す・履歴・権限を強める・戻す）もここから。
 * ターミナルのタブの窓と同じく、選ぶだけでは出している結果のタブは替わらない。閉じる・切り替える・ページ・取り消す・読み直す・戻すは押したときに行い、
 * 窓は開いたまま（結果が一覧に出る）。タブを作る・閉じる・名前を変える・移すは、ここには置かない（ワークスペースの窓。リーダーの `n` `t`）。
 * 操作はいつも、開いたときの DB のタブに行う。出しているタブがそれでなくなったら（閉じた・ほかのタブに替わった）、窓を閉じる。
 * キーは dbWindowKey.ts、決まりは docs/key-design.md。行を 1 回押すと選ぶだけで、ダブルクリックでそのタブを出す（Enter と同じ）。
 */
export function DbWindow(props: {
  db: Pick<
    DbTabs,
    | "shownDbTab"
    | "refOf"
    | "runOf"
    | "resultStructureOf"
    | "catalogOf"
    | "elevatedOf"
    | "showResult"
    | "closeResult"
    | "showView"
    | "stepPage"
    | "cancel"
    | "reloadCatalog"
    | "reloadStructure"
    | "openExport"
    | "openHistory"
    | "openElevate"
    | "endElevation"
  >;
  /** マシンの名前 */
  labelOf: (target: string) => string;
  /** マシンにつながっているか */
  connected: (target: string) => boolean;
  /** macOS か（実行のキーの書き方） */
  mac: boolean;
  /** サイドバーのスキーマの木にキーを向ける（窓は閉じてから呼ぶ） */
  onFocusTree: () => void;
  /**
   * 閉じる。refocus なら、閉じたあと、SQL の入力欄にキーを向け直す（Enter・何か操作をしたあと。開く前の所が、閉じた結果のタブのことがあるため）。
   * refocus でなければ、開く前にキーがあった所に戻る（何もせずに Esc。ほかの窓に替わるときも、その窓が自分でキーを取る）
   */
  onClose: (refocus: boolean) => void;
}): JSX.Element {
  // 窓の相手の DB のタブ（開いたときに出していたもの）。操作はいつもこれに行う
  const id = untrack(() => props.db.shownDbTab()?.id);
  // 出している DB のタブが替わった（閉じた・ほかのタブを出した）ら閉じる。別のタブの DB に、開いていた窓の操作をしない
  createEffect(() => {
    if (props.db.shownDbTab()?.id !== id) props.onClose(true);
  });

  const ref = () => (id === undefined ? undefined : props.db.refOf(id));
  const run = (): DbRun => (id === undefined ? EMPTY_RUN : props.db.runOf(id));
  const rows = createMemo(() =>
    dbWindowRows(run(), (tab) => props.db.resultStructureOf(tab)),
  );
  // 選んでいる結果のタブ。開いたときは、そのとき出していたタブに決めておく（開いている間に出しているタブが替わっても、
  // 選択は付いて動かない。何もしていないのに x が別のタブを閉じないため）。選んでいたタブが無くなったら（閉じた・上限で閉じた）、出しているタブを選び直す
  const [want, setWant] = createSignal<string | undefined>(
    untrack(() => run().active),
  );
  const selected = () => selectedResult(rows(), want());
  // 選んでいる行を見える所へ（結果のタブは 20 個まで増え、窓に収まらないと中身がスクロールする）。開いたときも、出しているタブが見えるように
  createEffect(() => {
    const tab = selected();
    if (tab === undefined) return;
    queueMicrotask(() =>
      document
        .getElementById(rowId(tab))
        ?.scrollIntoView?.({ block: "nearest" }),
    );
  });
  // できなかった理由。次のキーで消す
  const [note, setNote] = createSignal<string>();
  let acted = false;

  /** 選んでいる結果のタブ。無ければ（結果のタブが 1 つも無い）、その旨を窓の下に出して undefined */
  function pick(): string | undefined {
    const tab = selected();
    if (tab === undefined) setNote(T("dbWindow.note.noResult"));
    return tab;
  }

  /** 結果のタブ tab を出して、窓を閉じる（Enter・ダブルクリック。キーは SQL の入力欄へ） */
  function showAndClose(tab: string) {
    if (id === undefined) return;
    props.db.showResult(id, tab);
    props.onClose(true);
  }

  /** 選んでいる結果のタブを出してから f を行う（選んだタブに効かせるため）。結果のタブが無ければ、その旨を出す */
  function onSelected(f: (dbTab: string) => void) {
    const tab = pick();
    if (id === undefined || tab === undefined) return;
    props.db.showResult(id, tab);
    acted = true;
    f(id);
  }

  /** 窓を閉じてから f を行う（ほかの窓を開く・木にキーを向ける。閉じるとキーが開く前の所に戻るので、そのあとで動かす） */
  function closeThen(f: (dbTab: string) => void) {
    if (id === undefined) return;
    props.onClose(false);
    f(id);
  }

  function onKeyDown(e: KeyboardEvent) {
    const k = dbWindowKey(e);
    if (!k || id === undefined) return;
    e.preventDefault();
    setNote(undefined);
    switch (k.kind) {
      case "select":
        setWant(stepResult(rows(), selected(), k.step));
        break;
      case "show": {
        const tab = pick();
        if (tab !== undefined) showAndClose(tab);
        break;
      }
      case "close": {
        const tab = pick();
        if (tab !== undefined && props.db.closeResult(id, tab)) acted = true;
        break;
      }
      case "view":
        onSelected((d) => {
          if (!props.db.showView(d)) setNote(T("cannot.dbView.text"));
        });
        break;
      case "page":
        onSelected((d) => {
          const why = props.db.stepPage(d, k.step);
          if (why === "none") setNote(T("cannot.dbPage.none"));
          else if (why === "edge")
            setNote(
              T(
                k.step === "next"
                  ? "cannot.dbPage.noNext"
                  : "cannot.dbPage.noPrev",
              ),
            );
        });
        break;
      case "cancel":
        if (!run().running) setNote(T("dbWindow.note.notRunning"));
        else {
          acted = true;
          props.db.cancel(id);
        }
        break;
      case "export": {
        // 書き出せるか（行を返した結果があるか）を先に見る。書き出せなければ、窓を開いたまま理由を出す
        const tab = pick();
        if (tab === undefined) break;
        const t = run().tabs.find((x) => x.id === tab);
        if (!isExportable(t?.result)) setNote(T("cannot.dbExport.text"));
        else {
          props.db.showResult(id, tab);
          closeThen((d) => props.db.openExport(d));
        }
        break;
      }
      case "tree":
        closeThen(() => props.onFocusTree());
        break;
      case "refresh":
        acted = true;
        void props.db.reloadCatalog(id);
        props.db.reloadStructure(id);
        break;
      case "history":
        closeThen((d) => void props.db.openHistory(d));
        break;
      case "elevate":
        closeThen((d) => void props.db.openElevate(d));
        break;
      case "elevateEnd":
        acted = true;
        void props.db.endElevation(id);
        break;
      case "help":
        openKeyList("dbWindow");
        break;
    }
  }

  /** 上に出す、このタブの状態（つながり・実行中・強めている権限・木） */
  const status = createMemo(() => {
    const r = ref();
    if (!r || id === undefined) return [];
    const out: { text: string; alert?: boolean }[] = [];
    if (!props.connected(r.target))
      out.push({ text: T("dbWindow.offline"), alert: true });
    if (run().running) out.push({ text: T("dbWindow.running") });
    const elevated = props.db.elevatedOf(id);
    if (elevated.length > 0) out.push({ text: elevated.join(" · ") });
    const c = props.db.catalogOf(id);
    if (c.loading) out.push({ text: T("dbWindow.treeLoading") });
    else if (c.error)
      out.push({ text: T("dbWindow.treeError", { error: c.error }) });
    return out;
  });

  /** 下の段に出す、今効く操作（選んでいる結果のタブに合わせて変わる。見本）。どの窓でも同じキー（Enter・Esc・h j k l）は出さない */
  const actions = createMemo((): ActionGroup[] => {
    const r = rows().find((x) => x.id === selected());
    const t = run().tabs.find((x) => x.id === r?.id);
    const elevated = id === undefined ? [] : props.db.elevatedOf(id);
    return [
      {
        title: T("actions.db.selected"),
        items: [
          { keys: ["x"], label: T("actions.db.closeTab"), off: !r },
          {
            keys: ["s"],
            label: T("actions.db.view"),
            off: r?.table === undefined,
          },
          {
            keys: ["f", "b"],
            label: T("actions.db.page"),
            off: r?.state.kind !== "done",
          },
          {
            keys: ["e"],
            label: T("actions.db.export"),
            off: !isExportable(t?.result),
          },
        ],
      },
      {
        title: T("actions.db.tab"),
        items: [
          { keys: ["c"], label: T("actions.db.cancel"), off: !run().running },
          { keys: ["t"], label: T("actions.db.tree") },
          { keys: ["r"], label: T("actions.db.refresh") },
          { keys: ["h"], label: T("actions.db.history") },
          { keys: ["p"], label: T("actions.db.elevate") },
          {
            keys: ["P"],
            label: T("actions.db.elevateEnd"),
            off: elevated.length === 0,
          },
        ],
      },
    ];
  });

  return (
    <ModalCard
      label={T("dbWindow.label")}
      width={640}
      closeOnOutside
      onCancel={() => props.onClose(acted)}
      header={
        <div class={styles.head}>
          <CardTitle>
            {T("dbTab.tip", {
              connection: dbLabel(ref()?.connection ?? "", ref()?.variant),
              machine: props.labelOf(ref()?.target ?? ""),
            })}
          </CardTitle>
          <Show when={status().length > 0}>
            <div class={styles.status} role="status">
              <For each={status()}>
                {(s) => (
                  <span
                    class={styles.mark}
                    data-alert={s.alert ? "" : undefined}
                  >
                    {s.text}
                  </span>
                )}
              </For>
            </div>
          </Show>
        </div>
      }
      footer={
        <KeyFooter
          note={
            <Show when={note()}>
              {(n) => <CardText role="alert">{n()}</CardText>}
            </Show>
          }
          groups={actions()}
        />
      }
    >
      <div
        class={styles.list}
        tabIndex={0}
        role="listbox"
        aria-label={T("dbWindow.list")}
        aria-activedescendant={
          selected() === undefined ? undefined : rowId(selected()!)
        }
        onKeyDown={onKeyDown}
        ref={(el) => queueMicrotask(() => el.focus())}
      >
        <Show
          when={rows().length > 0}
          fallback={
            // 結果のタブが無い（まだ実行していない）。キーは一覧が受けたまま（t r h p P c は使える）
            <CardBody>
              <CardText role="status">
                {T("dbWindow.empty", {
                  key: props.mac ? "Cmd+Enter" : "Ctrl+Enter",
                })}
              </CardText>
            </CardBody>
          }
        >
          <ul class="card-rows">
            {/* 行は結果のタブの id で対応づける（中身は結果が届くたびに作り直される） */}
            <For each={rows().map((r) => r.id)}>
              {(tab) => (
                <Show when={rows().find((r) => r.id === tab)}>
                  {(r) => (
                    <ResultRow
                      row={r()}
                      selected={selected() === tab}
                      onPick={() => {
                        setNote(undefined);
                        setWant(tab);
                      }}
                      onShow={() => showAndClose(tab)}
                    />
                  )}
                </Show>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </ModalCard>
  );
}

/** 結果のタブ 1 行。見出しと印（出している・仮・テーブル・Structure）と状態。1 回押すと選び（onPick）、ダブルクリックで出す（onShow）。 */
function ResultRow(props: {
  row: DbWindowRow;
  selected: boolean;
  onPick: () => void;
  onShow: () => void;
}): JSX.Element {
  return (
    <li
      id={rowId(props.row.id)}
      class="card-row"
      role="option"
      aria-selected={props.selected ? "true" : "false"}
      onClick={() => props.onPick()}
      onDblClick={() => props.onShow()}
    >
      <span class={`card-row-name ${styles.name}`}>
        <span class={styles.title}>{props.row.name}</span>
        <span class={styles.marks}>
          <Show when={props.row.shown}>
            <span class={styles.mark} data-shown="">
              {T("dbWindow.shown")}
            </span>
          </Show>
          <Show when={props.row.preview}>
            <span class={styles.mark}>{T("dbWindow.preview")}</span>
          </Show>
          <Show when={props.row.table}>
            {(t) => <span class={styles.mark}>{t()}</span>}
          </Show>
          <Show when={props.row.structure}>
            <span class={styles.mark}>{T("db.view.structure")}</span>
          </Show>
        </span>
      </span>
      <span
        class="card-row-state"
        classList={{ [styles.failed]: props.row.state.kind === "error" }}
      >
        {stateText(props.row.state)}
      </span>
    </li>
  );
}
