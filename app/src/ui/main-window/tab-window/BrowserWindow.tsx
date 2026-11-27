import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  untrack,
  type JSX,
} from "solid-js";

import { isNewTab } from "../../../features/browser/newTab.ts";
import type { BrowserTab } from "../../../features/browser/tabs.ts";
import {
  browserWindowMarks,
  browserWindowRows,
  browserWindowTitle,
  selectedRow,
  stepRow,
  type BrowserOp,
  type BrowserWindowRow,
} from "../../../features/browser/window.ts";
import { T } from "../../../i18n/index.ts";
import "../../components/card.css";
import { CardText, CardTitle, ModalCard } from "../../components/Card.tsx";
import { KeyFooter } from "../../components/KeyFooter.tsx";
import { Kbd } from "../../components/KeyHints.tsx";
import { openKeyList } from "../commands/KeyListDialog.tsx";
import { browserWindowFooter, browserWindowKey } from "./browserWindowKey.ts";
import styles from "./BrowserWindow.module.css";

const rowId = (op: BrowserOp) => `browser-window-op-${op}`;

/** 行ったあと、Dialog を開いたままにする操作（戻る・進む。続けて押せる。どこへ移ったかは上の題と URL に出る）。 */
const STAYS: ReadonlySet<BrowserOp> = new Set<BrowserOp>(["back", "forward"]);
/** キーをページ以外へ向ける操作（URL バー・検索の欄・ブックマークの一覧）。閉じたあと、ページにキーを戻さない。 */
const MOVES_FOCUS: ReadonlySet<BrowserOp> = new Set<BrowserOp>([
  "url",
  "find",
  "bookmarks",
]);

/**
 * ブラウザのタブの Dialog（リーダーの `a`。#459）。開いたときに出していたブラウザのタブ 1 つ（とそのページ）の状態
 * （題・URL・シークレット・読み込み中・読み込めなかった・通信を記録中・表示の大きさ）と、そのページへの操作を 1 行ずつ出す。
 * 今できない操作は、行にその理由を出して薄くする（選ぶときは飛ばす。字を押すと、Dialog の下に理由を出す）。
 * 行を選んで Enter か、行の字で行う。戻る・進むは Dialog を開いたまま（続けて押せる）、ほかは Dialog を閉じてから行う。
 * タブを作る・閉じる・名前を変える・移すは、ここには置かない（Workspace switcher。リーダーの `n` `t`）。
 * 操作はいつも、開いたときのタブに行う。出しているタブがそれでなくなったら（閉じた・ほかのタブに替わった）、Dialog を閉じる。
 * キーは browserWindowKey.ts、行と理由は features/browser/window.ts、決まりは docs/key-design.md。
 * 行を 1 回押すと選ぶだけで、ダブルクリックでその操作を行う（Enter と同じ）。
 */
export function BrowserWindow(props: {
  /** 今出しているブラウザのタブ（features/browser/pages.ts の shownBrowserTab） */
  shown: () => BrowserTab | undefined;
  /** ブラウザのタブ tab（id）のページに、操作 op を行う（features/commands/run.ts の runBrowserOn） */
  run: (tab: string, op: BrowserOp) => void;
  /**
   * 閉じる。refocus なら、閉じたあと、今のページにキーを向け直す（操作をしたあと）。
   * refocus でなければ、開く前にキーがあった所に戻る（何もせずに Esc。キーをほかへ向ける操作も、その先が自分でキーを取る）
   */
  onClose: (refocus: boolean) => void;
}): JSX.Element {
  // Dialog の相手のタブ（開いたときに出していたもの）。操作はいつもこれに行う
  const id = untrack(() => props.shown()?.id);
  // 出しているブラウザのタブが替わった（閉じた・ほかのタブを出した）ら閉じる。別のタブのページに、開いていた Dialog の操作をしない
  createEffect(() => {
    if (props.shown()?.id !== id) props.onClose(true);
  });

  const tab = () => {
    const t = props.shown();
    return t?.id === id ? t : undefined;
  };
  const rows = createMemo(() => {
    const t = tab();
    return t ? browserWindowRows(t) : [];
  });
  const marks = createMemo(() => {
    const t = tab();
    return t ? browserWindowMarks(t) : [];
  });
  // 選んでいる行。初めは、上から見て最初の今できる行
  const [want, setWant] = createSignal<BrowserOp | undefined>();
  const selected = () => selectedRow(rows(), want());
  // できなかった理由。次のキーで消す
  const [note, setNote] = createSignal<string>();
  let acted = false;

  /** 操作 op を行う。今できなければ、Dialog の下に理由を出す */
  function run(op: BrowserOp) {
    if (id === undefined) return;
    const why = rows().find((r) => r.op === op)?.why;
    if (why) {
      setWant(op);
      setNote(why);
      return;
    }
    if (STAYS.has(op)) {
      acted = true;
      setWant(op);
      props.run(id, op);
      return;
    }
    // 先に閉じる（閉じると、キーが開く前の所かページに戻る）。そのあとで、キーをほかへ向ける操作を行う
    props.onClose(!MOVES_FOCUS.has(op));
    props.run(id, op);
  }

  function onKeyDown(e: KeyboardEvent) {
    const k = browserWindowKey(e);
    if (!k || id === undefined) return;
    e.preventDefault();
    setNote(undefined);
    switch (k.kind) {
      case "select":
        setWant(stepRow(rows(), selected(), k.step));
        break;
      case "run": {
        const op = selected();
        if (op) run(op);
        break;
      }
      case "op":
        run(k.op);
        break;
      case "help":
        openKeyList("browserWindow");
        break;
    }
  }

  return (
    <ModalCard
      label={T("browserWindow.label")}
      width={560}
      closeOnOutside
      onCancel={() => props.onClose(acted)}
      header={
        <div class={styles.head}>
          <CardTitle>
            <span class={styles.title}>
              {tab() ? browserWindowTitle(tab()!) : ""}
            </span>
          </CardTitle>
          <Show when={tab() && !isNewTab(tab()!)}>
            {/* 中継しているタブも、元の URL（URL バーと同じ）。文字は、そのまま文字として出す */}
            <p class={styles.url} title={tab()?.url}>
              {tab()?.url}
            </p>
          </Show>
          <Show when={marks().length > 0}>
            <div class={styles.status} role="status">
              <For each={marks()}>
                {(m) => (
                  <span
                    class={styles.mark}
                    data-alert={m.alert ? "" : undefined}
                  >
                    {m.text}
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
          rows={browserWindowFooter(rows())}
        />
      }
    >
      <div
        class={styles.list}
        tabIndex={0}
        role="listbox"
        aria-label={T("browserWindow.list")}
        aria-activedescendant={
          selected() === undefined ? undefined : rowId(selected()!)
        }
        onKeyDown={onKeyDown}
        ref={(el) => queueMicrotask(() => el.focus())}
      >
        <ul class="card-rows">
          <For each={rows()}>
            {(r) => (
              <OpRow
                row={r}
                selected={selected() === r.op}
                onPick={() => {
                  setNote(r.why);
                  setWant(r.op);
                }}
                onRun={() => run(r.op)}
              />
            )}
          </For>
        </ul>
      </div>
    </ModalCard>
  );
}

/** 操作 1 行。押す字・操作の名前と、今できなければその理由。1 回押すと選び（onPick）、ダブルクリックで行う（onRun）。 */
function OpRow(props: {
  row: BrowserWindowRow;
  selected: boolean;
  onPick: () => void;
  onRun: () => void;
}): JSX.Element {
  return (
    <li
      id={rowId(props.row.op)}
      class="card-row"
      classList={{ [styles.disabled]: !!props.row.why }}
      role="option"
      aria-selected={props.selected ? "true" : "false"}
      aria-disabled={props.row.why ? "true" : undefined}
      onClick={() => props.onPick()}
      onDblClick={() => props.onRun()}
    >
      <span class={`card-row-name ${styles.name}`}>
        <span class={styles.key}>
          <Kbd>{props.row.key}</Kbd>
        </span>
        {props.row.label}
      </span>
      <Show when={props.row.why}>
        {(w) => <span class="card-row-state">{w()}</span>}
      </Show>
    </li>
  );
}
