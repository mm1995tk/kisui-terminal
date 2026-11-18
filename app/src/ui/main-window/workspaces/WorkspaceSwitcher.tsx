import { T } from "../../../i18n/index.ts";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type JSX,
} from "solid-js";

import { startDrag } from "../sidebar/drag.ts";
import type { Row } from "../../../features/workspaces/rows.ts";
import { type RowEdit, SwitcherRow, SwitcherTabs } from "./SwitcherParts.tsx";
import { ModalCard } from "../../components/Card.tsx";
import { isCancelKey } from "../../components/cancelKey.ts";
import { moveRow } from "../../../features/sessions/machineList.ts";
import { confirmKey, switcherKey } from "./switcherKey.ts";
import { startTabDrag } from "./tabMoveDrag.ts";
import "./switcher.css";

const rowId = (i: number) => `switcher-row-${i}`;

/**
 * ワークスペースを切り替える窓（リーダーの `w`。#282・#296）。ワークスペースの操作（移る・作る・名前を変える・閉じる・並べ替える）は、すべてここでする。
 * 左に全ワークスペース（サイドバーと同じ並び）、右に左で選んでいる行のタブの一覧だけを出す。
 * キーは switcherKey.ts、決まりは docs/key-design.md。左の行を 1 回押すと選ぶだけで、ダブルクリックか Enter で移る。
 * 行の左端のつかむ所からのドラッグで並べ替える（サイドバーの帯と同じ drag.ts。並びを覚えるのは呼んだ側）。
 * 右のタブの行を押すと、そのワークスペースのそのタブへ移る。移ったあとに窓を閉じるのは、呼んだ側（出すのをやめる）。
 * 右のタブの行のつかむ所からのドラッグで、タブを並べ替える・別のワークスペースへ移す（#308。tabMoveDrag.ts）。ドラッグ中に左の行の上へ来ると、
 * 右の列がそのワークスペースのタブに替わり、落とした位置に入る（左の行の上で落とすと、一番後ろに入る。空のワークスペースにも落とせる）。
 * 名前を変えるのは、行の中の入力欄（サイドバーの帯と同じ。変換を確定する Enter では決めない）。閉じるのは、y / n で確かめてから。
 */
export function WorkspaceSwitcher(props: {
  /** サイドバーの行（GUI のワークスペース 1 つが 1 行）。並びは、ユーザーが並べた順 */
  rows: readonly Row[];
  /** 左の行を選んで移った（Enter・ダブルクリック） */
  onGo: (row: Row) => void;
  /** 右のタブの行を押した */
  onTab: (gws: string, key: string) => void;
  /** 1 つ下・上へ並べ替える（J K） */
  onReorder: (gws: string, dir: "up" | "down") => void;
  /** つかんで落とした（before は、その行のすぐ前の GUI のワークスペースの id。一番後ろなら null） */
  onDrop: (gws: string, before: string | null) => void;
  /** 右のタブの行をつかんで落とした（タブ key を、ワークスペース gws の before のタブの前へ。一番後ろなら null。別のワークスペースへも移せる） */
  onTabMove: (key: string, gws: string, before: string | null) => void;
  /** 「ワークスペースを作る」（窓は閉じる） */
  onNew: () => void;
  /** 名前を変える入力欄を開くときの、今の名前と、空にしたときの番号の名前 */
  renameInit: (gws: string) => { current: string; auto: string } | undefined;
  /** 入力欄で名前を決めた。断られたら、その理由を返す（入力欄は開けたまま） */
  onRename: (gws: string, name: string) => string | undefined;
  /** 閉じることを確かめた（窓は開けたまま。閉じられなければ、呼んだ側が理由を出す） */
  onClose: (gws: string) => void;
  onCancel: () => void;
}): JSX.Element {
  // 選んでいるのは位置ではなくワークスペース。並べ替えても、同じワークスペースを選び続ける
  const [sel, setSel] = createSignal<string | undefined>(
    (props.rows.find((r) => r.band.focused) ?? props.rows[0])?.gws,
  );
  // 選んでいたワークスペースが消えたら、前の位置に寄せる（memo の前の値を使う）
  const index = createMemo((prev: number) => {
    const i = props.rows.findIndex((r) => r.gws === sel());
    return i >= 0 ? i : Math.min(prev, Math.max(0, props.rows.length - 1));
  }, 0);
  const selected = (): Row | undefined => props.rows[index()];
  // 名前を変えている行と、閉じる確認をしている行（どちらも、その行のワークスペースの id。ほかの行を選んだら、やめる）
  const [editing, setEditing] = createSignal<
    (RowEdit & { gws: string }) | undefined
  >();
  const [confirming, setConfirming] = createSignal<string | undefined>();
  let list!: HTMLUListElement;
  let right!: HTMLDivElement;

  // 選ぶ行が見える所へ（9 個を超えると、一覧がスクロールする）
  createEffect(() => {
    const i = index();
    document.getElementById(rowId(i))?.scrollIntoView?.({ block: "nearest" });
  });

  // 確認や入力欄を出している行が、窓の外の理由（マシンが切れて記録から外れたなど）で消えたら、やめる（確認が見えないまま、キーが効かなくならないように）
  createEffect(() => {
    const has = (g: string) => props.rows.some((r) => r.gws === g);
    const c = confirming();
    if (c !== undefined && !has(c)) setConfirming(undefined);
    const e = editing();
    if (e && !has(e.gws)) setEditing(undefined);
  });

  /** 選ぶ行を変える。名前を変える・閉じる確認は、その行のものなので、やめる。 */
  function select(gws: string | undefined) {
    if (gws !== sel()) {
      setEditing(undefined);
      setConfirming(undefined);
    }
    setSel(gws);
  }
  /** 窓のキーが届く一覧にフォーカスを戻す（ボタンや入力欄を使ったあと） */
  const focusList = () => list.focus();

  function startRename(r: Row) {
    const init = props.renameInit(r.gws);
    if (!init) return;
    setConfirming(undefined);
    setEditing({ gws: r.gws, ...init });
  }
  function startClose(r: Row) {
    setEditing(undefined);
    setConfirming(r.gws);
    focusList();
  }
  function submitRename(name: string) {
    const e = editing();
    if (!e) return;
    const bad = props.onRename(e.gws, name);
    if (bad) setEditing({ ...e, error: bad });
    else {
      setEditing(undefined);
      focusList();
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    // 名前を変える入力欄の中のキーは、入力欄が受ける（j や n を打てるように）
    if (e.target instanceof HTMLInputElement) return;
    const c = confirming();
    if (c !== undefined) {
      // 閉じる確認の間は y / n / Esc だけ（Esc は、窓ではなく確認をやめる）
      const k = confirmKey(e);
      if (k) {
        e.preventDefault();
        setConfirming(undefined);
        if (k === "yes") props.onClose(c);
      } else if (isCancelKey(e)) {
        e.preventDefault();
        setConfirming(undefined);
      } else if (e.key !== "Tab") e.preventDefault();
      return;
    }
    const k = switcherKey(e);
    if (!k) return;
    e.preventDefault();
    switch (k.kind) {
      case "move":
        select(props.rows[moveRow(index(), k.to, props.rows.length)]?.gws);
        break;
      case "go": {
        const r = selected();
        if (r) props.onGo(r);
        break;
      }
      case "reorder": {
        const r = selected();
        if (r) props.onReorder(r.gws, k.dir);
        break;
      }
      case "new":
        props.onNew();
        break;
      case "rename": {
        const r = selected();
        if (r) startRename(r);
        break;
      }
      case "close": {
        const r = selected();
        if (r) startClose(r);
        break;
      }
    }
  }

  /** つかむ所を押した。左の一覧の行を、真ん中の高さで比べて、落とした先の行の前へ動かす。 */
  function grab(e: PointerEvent, gws: string) {
    startDrag(e, {
      scroller: list,
      self: gws,
      rows: () =>
        [...list.querySelectorAll<HTMLElement>("li.switch-row[data-gws]")].map(
          (el) => ({ key: el.dataset.gws!, el, ref: el }),
        ),
      onDrop: (before) => props.onDrop(gws, before),
    });
  }

  /**
   * 右のタブの行のつかむ所を押した。左の行の上へ来たら、その行を選んで右の列を替える。やめたら、つかんだときのワークスペースを選び直す。
   * 落としたあとは、落とした先のワークスペースを選んだままにする（移した結果が見える）。
   */
  function grabTab(e: PointerEvent, key: string) {
    const from = selected()?.gws;
    const row = (e.currentTarget as HTMLElement).closest<HTMLElement>(
      "li.tab-row",
    );
    if (from === undefined || !row) return;
    startTabDrag(e, {
      row,
      self: key,
      left: list,
      right,
      shown: () => selected()?.gws,
      onOver: select,
      onDrop: (gws, before) => props.onTabMove(key, gws, before),
      onCancel: () => select(from),
    });
  }

  return (
    <ModalCard
      label={T("switcher.label")}
      width={880}
      closeOnOutside
      onCancel={props.onCancel}
    >
      <div class="machine-dialog switcher">
        <div class="card-body">
          <h1 class="card-title">{T("switcher.title")}</h1>
        </div>
        <div class="switcher-cols">
          <div class="switcher-left">
            <ul
              class="card-rows switch-rows"
              tabIndex={0}
              role="listbox"
              aria-label={T("switcher.title")}
              aria-activedescendant={selected() ? rowId(index()) : undefined}
              onKeyDown={onKeyDown}
              ref={(el) => {
                list = el;
                queueMicrotask(() => el.focus());
              }}
            >
              <For each={props.rows}>
                {(r, i) => (
                  <SwitcherRow
                    id={rowId(i())}
                    row={r}
                    selected={index() === i()}
                    edit={editing()?.gws === r.gws ? editing() : undefined}
                    confirming={confirming() === r.gws}
                    onSelect={() => {
                      select(r.gws);
                      if (!editing()) focusList();
                    }}
                    onGo={() => props.onGo(r)}
                    onGrab={(e) => grab(e, r.gws)}
                    onRename={() => startRename(r)}
                    onClose={() => startClose(r)}
                    onRenameSubmit={submitRename}
                    onRenameCancel={(byKey) => {
                      setEditing(undefined);
                      if (byKey) focusList();
                    }}
                  />
                )}
              </For>
              <Show when={props.rows.length === 0}>
                <li class="card-empty">{T("switcher.empty")}</li>
              </Show>
            </ul>
            <button
              type="button"
              class="switch-new"
              tabIndex={-1}
              onClick={() => props.onNew()}
            >
              <span>+ {T("switcher.new")}</span>
              <kbd>n</kbd>
            </button>
          </div>
          <div class="switcher-right" ref={right}>
            <Show when={selected()}>
              {(r) => (
                <SwitcherTabs row={r()} onTab={props.onTab} onGrab={grabTab} />
              )}
            </Show>
          </div>
        </div>
        <div class="card-body switch-keys">
          <div class="switch-keys-col">
            <h2>{T("switcher.keys.goHeading")}</h2>
            <p>
              <kbd>j</kbd> <kbd>k</kbd> {T("machineDialog.keys.select")}
            </p>
            <p>
              <kbd>Enter</kbd> {T("switcher.keys.go")}
            </p>
            <p>
              <kbd>Esc</kbd> {T("switcher.keys.close")}
            </p>
          </div>
          <div class="switch-keys-col">
            <h2>{T("switcher.keys.changeHeading")}</h2>
            <p>
              <kbd>n</kbd> {T("switcher.keys.new")}
            </p>
            <p>
              <kbd>r</kbd> {T("switcher.keys.rename")}
            </p>
            <p>
              <kbd>x</kbd> {T("switcher.keys.closeWorkspace")}
            </p>
            <p>
              <kbd>J</kbd> <kbd>K</kbd> {T("switcher.keys.reorder")}
            </p>
          </div>
          <p class="switch-keys-note">{T("switcher.keys.dragTab")}</p>
        </div>
      </div>
    </ModalCard>
  );
}
