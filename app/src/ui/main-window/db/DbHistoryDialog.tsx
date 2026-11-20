// DB のタブの、接続ごとのクエリの履歴の窓（リーダーの `d h`。#349）。その接続で実行した SQL を新しい順に出し、
// 字を打って絞り込み、選んだものを入力欄に入れる（実行はしない）。履歴は kisui serve が持ち、窓を開けるたびに聞く。
// 一覧の見た目（.history-*）は、クリップボードの履歴の窓と同じ（ui/components/card.css）。
import { T } from "../../../i18n/index.ts";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type JSX,
} from "solid-js";

import { basicHints } from "../../../features/commands/placeKeys.ts";
import type { DbHistoryAsk } from "../../../features/db/historyController.ts";
import {
  atText,
  filterHistory,
  historyEmptyText,
  sqlPreview,
} from "../../../features/db/history.ts";
import { dbHistoryKey } from "../../../features/db/keys.ts";
import type { DbHistoryEntry } from "../../../infrastructure/rpc/protocol.ts";
import "../../components/card.css";
import { Button } from "../../components/Button.tsx";
import {
  CardBody,
  CardFooter,
  CardTitle,
  ModalCard,
} from "../../components/Card.tsx";
import { Input } from "../../components/Field.tsx";
import { KeyHints } from "../../components/KeyHints.tsx";
import { openKeyList } from "../commands/KeyListDialog.tsx";

/** 履歴の窓。↓ ↑ で選び、Enter かダブルクリックで onChoose（その SQL を入力欄へ）、Esc で onCancel を呼ぶ。 */
export function DbHistoryDialog(props: {
  ask: DbHistoryAsk;
  onChoose: (sql: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [sel, setSel] = createSignal(0);

  const shown = createMemo(() =>
    filterHistory(props.ask.entries ?? [], query()),
  );
  const selectedIndex = () => Math.min(sel(), shown().length - 1);
  /** `?` が今効くか（絞り込みが空の間だけ） */
  const helpOn = () => query() === "";

  function choose() {
    const e = shown()[selectedIndex()];
    if (e) props.onChoose(e.sql);
  }

  function onKeyDown(e: KeyboardEvent) {
    const k = dbHistoryKey(e, helpOn());
    if (!k) return;
    e.preventDefault();
    if (k.kind === "step")
      setSel((i) => Math.min(shown().length - 1, Math.max(0, i + k.step)));
    else if (k.kind === "choose") choose();
    else openKeyList("dbHistory");
  }

  return (
    <ModalCard
      label={T("db.history.label")}
      width={720}
      onCancel={props.onCancel}
    >
      <CardBody>
        <div class="history-head">
          <CardTitle>
            {T("db.history.title", { connection: props.ask.connection })}
          </CardTitle>
          <Button onClick={props.onCancel}>{T("db.history.close")}</Button>
        </div>
        <Input
          type="text"
          placeholder={T("db.history.filterPlaceholder")}
          aria-label={T("db.history.filter")}
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
          ref={(el) => queueMicrotask(() => el.focus())}
        />
      </CardBody>
      <Show
        when={shown().length > 0}
        fallback={
          <p class="card-empty history-empty">{historyEmptyText(props.ask)}</p>
        }
      >
        <HistoryRows
          entries={shown()}
          selectedIndex={selectedIndex()}
          onSelect={setSel}
          onChoose={choose}
        />
      </Show>
      <CardFooter>
        <KeyHints
          items={basicHints({
            select: ["↓", "↑"],
            decide: T("db.history.use"),
            help: helpOn(),
            end: "close",
          })}
        />
      </CardFooter>
    </ModalCard>
  );
}

/** 履歴の一覧。選んでいる行は selectedIndex（見える所へスクロールする）。 */
function HistoryRows(props: {
  entries: readonly DbHistoryEntry[];
  selectedIndex: number;
  onSelect: (i: number) => void;
  onChoose: () => void;
}): JSX.Element {
  let list: HTMLUListElement | undefined;
  createEffect(() => {
    const i = props.selectedIndex;
    queueMicrotask(() =>
      list?.children[i]?.scrollIntoView?.({ block: "nearest" }),
    );
  });
  return (
    <ul
      class="card-rows history-rows"
      role="listbox"
      aria-label={T("db.history.list")}
      ref={(el) => (list = el)}
    >
      <For each={props.entries}>
        {(e, i) => (
          <DbHistoryRow
            entry={e}
            selected={i() === props.selectedIndex}
            onSelect={() => props.onSelect(i())}
            onChoose={props.onChoose}
          />
        )}
      </For>
    </ul>
  );
}

/** 履歴の 1 行：SQL の見出しと、右に（コーディングエージェントが実行した文の札・失敗の札と）送った時刻。 */
function DbHistoryRow(props: {
  entry: DbHistoryEntry;
  selected: boolean;
  onSelect: () => void;
  onChoose: () => void;
}): JSX.Element {
  return (
    <li role="presentation">
      <button
        type="button"
        class="card-row"
        role="option"
        tabIndex={-1}
        aria-selected={props.selected}
        title={props.entry.sql}
        // 入力欄からフォーカスを動かさない（押したあとも↑↓と Enter が効くように）
        onMouseDown={(ev) => ev.preventDefault()}
        onClick={props.onSelect}
        onDblClick={props.onChoose}
      >
        <span class="card-row-name">{sqlPreview(props.entry.sql)}</span>
        <span class="card-row-state">
          {props.entry.actor === "agent"
            ? `${T("db.history.agentMark")} · `
            : ""}
          {props.entry.ok ? "" : `${T("db.history.failedMark")} · `}
          {atText(props.entry.at)}
        </span>
      </button>
    </li>
  );
}
