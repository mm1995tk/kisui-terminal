// メインウィンドウの中で、キーの行き先を移す（表示用の状態）。
// - 今使っているペイン（ターミナル。内蔵ブラウザのタブを出していればそのページ、DB のタブなら SQL の入力欄）へ。
// - サイドバーのファイルツリー・CHANGES へ（shj の Space e・Space E。閉じているサイドバーは先に開く）。
// - 内蔵ブラウザのページにキーがあるときに押したリーダー・近道のあと、ページへ戻す。
// 向ける先の要素は、描いた部品（TerminalGrid・BrowserArea・UrlBar・FindBar）が渡す関数で受け取る。
import { createEffect, on, onCleanup, untrack, type Accessor } from "solid-js";

import type { WorkspaceFocus } from "../../features/workspaces/rows.ts";
import type {
  Workspace,
  WorkspaceId,
} from "../../infrastructure/rpc/protocol.ts";
import type { WindowEls } from "./els.ts";
import { changesRow } from "./sidebar/changes/changesFocus.ts";
import {
  explorerRow,
  startFocusStep,
} from "./sidebar/file-tree/explorerFocus.ts";

/** createFocus が返す、キーの行き先を移す操作。 */
export type FocusUi = ReturnType<typeof createFocus>;

/** キーの行き先を移す操作を作る。向ける先の要素は、描いた部品が set…Focus で渡す。 */
export function createFocus(deps: {
  els: WindowEls;
  /** 内蔵ブラウザのタブを使うか（設定の [gui.browser] enabled） */
  browser: boolean;
  focus: Accessor<WorkspaceFocus | null>;
  workspaces: Accessor<Record<string, Workspace[]>>;
  /** ツリーの中身が変わるたびに進む数 */
  treeVersion: Accessor<number>;
  /** 今のワークスペースで出しているブラウザのタブ（ターミナルのタブを出していれば undefined） */
  shownBrowserTab: Accessor<unknown>;
  /** 今のワークスペースで出している DB のタブ（#347。出していなければ undefined） */
  shownDbTab: Accessor<unknown>;
  /** 空のワークスペース（#307）を選んでいて、タブが無いことを伝える画面を出しているか */
  emptyShown: Accessor<boolean>;
  sidebarOpen: Accessor<boolean>;
  changeSidebarOpen: (open: boolean) => void;
  resizeMode: Accessor<boolean>;
  /** リーダーに入っているか */
  inLeader: () => boolean;
}) {
  const {
    els,
    focus,
    workspaces,
    treeVersion,
    shownBrowserTab,
    sidebarOpen,
    changeSidebarOpen,
    resizeMode,
  } = deps;
  // キーを向ける関数。描いた部品が渡す（無くなったら undefined）
  let focusActiveTerminal: (() => void) | undefined;
  let focusBrowserPage: (() => void) | undefined;
  let focusFind: (() => void) | undefined;
  let focusUrlBar: (() => void) | undefined;
  let focusEmpty: (() => void) | undefined;
  let focusDb: (() => void) | undefined;
  let focusDbTree: (() => void) | undefined;

  /** shj の Space e：フォーカスしているワークスペースなら、サイドバーのファイルツリーにキーを向ける。 */
  function focusExplorer(target: string, id: WorkspaceId) {
    const f = untrack(focus);
    if (!f || f.target !== target || f.id !== id) return;
    focusInSidebar(() => explorerRow(els.nav));
  }
  /**
   * サイドバーの中の行（ツリー・CHANGES）にキーを向ける。閉じているサイドバーは、先に開く（隠れたままでは、キーの行き先が見えない）。
   * 開いた直後は画面（display）がまだ変わっていないことがあるので、向けるのは画面が変わったあとにする。
   */
  function focusInSidebar(rowOf: () => HTMLElement | null | undefined) {
    const go = () => {
      const row = rowOf();
      row?.focus();
      row?.scrollIntoView({ block: "nearest" });
    };
    if (untrack(sidebarOpen)) go();
    else {
      changeSidebarOpen(true);
      queueMicrotask(go);
    }
  }
  /**
   * shj が引数なしで起動した直後の、ツリーへのフォーカスの頼み（explorer.focus の start）。
   * 起動した直後は、ツリーの行がまだ届いていなかったり、cd したフォルダへの切り替え（1 秒おきに見る）でツリーが
   * 捨てられて取り直されたりする。そこで頼みを少しのあいだ覚え、ツリーの行が描かれるたびに、ツリーにキーが無ければ向け直す。
   * キーを打った・押した・別のワークスペースに移った・時間が過ぎたら捨てる。
   */
  let startFocus: { target: string; id: WorkspaceId; off: () => void } | null =
    null;
  function cancelStartFocus() {
    startFocus?.off();
    startFocus = null;
  }
  function requestStartFocus(target: string, id: WorkspaceId) {
    const f = untrack(focus);
    if (!f || f.target !== target || f.id !== id) return;
    // 閉じているサイドバーは、起動した直後の自動のフォーカスでは開かない（開けるのは、利用者がツリーへ移る操作だけ）
    if (!untrack(sidebarOpen)) return;
    cancelStartFocus();
    const cancel = () => cancelStartFocus();
    window.addEventListener("keydown", cancel, true);
    window.addEventListener("pointerdown", cancel, true);
    const timer = window.setTimeout(cancel, 3000);
    startFocus = {
      target,
      id,
      off: () => {
        window.removeEventListener("keydown", cancel, true);
        window.removeEventListener("pointerdown", cancel, true);
        window.clearTimeout(timer);
      },
    };
    retryStartFocus();
  }
  function retryStartFocus() {
    const p = startFocus;
    if (!p) return;
    const f = untrack(focus);
    const step = startFocusStep({
      stillFocused: !!f && f.target === p.target && f.id === p.id,
      sidebarOpen: untrack(sidebarOpen),
      keyInTree: !!els.nav?.contains(document.activeElement),
      hasRow: explorerRow(els.nav) !== null,
    });
    if (step === "drop") cancelStartFocus();
    else if (step === "focus") focusExplorer(p.target, p.id);
  }
  createEffect(() => {
    treeVersion();
    workspaces();
    focus();
    untrack(retryStartFocus);
  });
  onCleanup(cancelStartFocus);
  /** shj の Space E・cmd.diffchanges：フォーカスしているワークスペースなら、サイドバーの CHANGES にキーを向ける。 */
  function focusChanges(target: string, id: WorkspaceId) {
    const f = untrack(focus);
    if (!f || f.target !== target || f.id !== id) return;
    focusInSidebar(() => changesRow(els.nav));
  }

  /**
   * 今使っているターミナルの欄にキーを向ける。今のワークスペースで内蔵ブラウザのタブを出していれば、そのページに向ける。
   */
  function focusTerminal() {
    if (untrack(shownBrowserTab)) {
      focusBrowserPage?.();
      return;
    }
    // DB のタブ（#347）は、SQL の入力欄に置く（描かれるのを待つ。開いた直後は、まだ画面が出ていない）
    if (untrack(deps.shownDbTab)) {
      queueMicrotask(() => focusDb?.());
      return;
    }
    // 空のワークスペース（#307）には、キーを向けるペインもページも無い。タブが無いことを伝える画面に置く
    // （描かれるのを待つ。移った直後は、まだ画面が出ていない）
    if (untrack(deps.emptyShown)) {
      queueMicrotask(() => focusEmpty?.());
      return;
    }
    // 足した欄のターミナルが開くのを待つ（作ったばかりのワークスペースは、欄が描かれるまでもう少しかかる）
    const focus = () => focusActiveTerminal?.();
    queueMicrotask(() => {
      focus();
      if (!els.main?.contains(document.activeElement))
        requestAnimationFrame(() => requestAnimationFrame(focus));
    });
  }

  /**
   * ページにキーがあるときにリーダーか近道を押した（殻がキーをこの画面に移してから届く）。そのときの画面のキーの行き先。
   * 押した操作が終わって（リーダーなら出て）も、キーの行き先がそのままなら、ページにキーを戻す
   */
  let pageReturn: Element | null | undefined;
  function returnToPageLater() {
    setTimeout(() =>
      requestAnimationFrame(() => {
        if (pageReturn === undefined || deps.inLeader()) return;
        const was = pageReturn;
        pageReturn = undefined;
        if (
          !untrack(shownBrowserTab) ||
          untrack(resizeMode) ||
          document.querySelector("dialog[open]")
        )
          return;
        // 押した操作がキーをほかへ向けた（名前の入力欄・ファイルツリーなど）ときは、戻さない
        if (document.activeElement !== was) return;
        focusTerminal();
      }),
    );
  }

  if (deps.browser) {
    // リサイズモードを出たら、ページにキーを戻す
    createEffect(
      on(resizeMode, (m, prev) => {
        if (prev && !m && untrack(shownBrowserTab)) focusTerminal();
      }),
    );
  }

  return {
    focusTerminal,
    focusExplorer,
    focusChanges,
    requestStartFocus,
    /** ページから押したときに覚えた「キーを戻す先」を捨てる（押した操作がキーをほかへ向けるとき） */
    forgetPageReturn() {
      pageReturn = undefined;
    },
    /** ページにキーがあるときに押された。まだ覚えていなければ、今の画面のキーの行き先を「戻す先」として覚える */
    markPageReturn() {
      if (pageReturn === undefined) pageReturn = document.activeElement;
    },
    /** 「キーを戻す先」を覚えているか */
    hasPageReturn: () => pageReturn !== undefined,
    returnToPageLater,
    /** 今使っているターミナルのペインにキーを向ける関数を受け取る（TerminalGrid） */
    setTerminalFocus(f: (() => void) | undefined) {
      focusActiveTerminal = f;
    },
    /** 今出しているタブのページにキーを向ける関数を受け取る（BrowserArea） */
    setBrowserPageFocus(f: () => void) {
      focusBrowserPage = f;
    },
    /** ページ内検索の欄の入力欄にキーを向ける関数を受け取る（FindBar） */
    setFindFocus(f: () => void) {
      focusFind = f;
    },
    /** 空のワークスペースの画面にキーを向ける関数を受け取る（EmptyWorkspace。消えるときは undefined） */
    setEmptyFocus(f: (() => void) | undefined) {
      focusEmpty = f;
    },
    /** DB のタブの SQL の入力欄にキーを向ける関数を受け取る（DbTabView。消えるときは undefined） */
    setDbFocus(f: (() => void) | undefined) {
      focusDb = f;
    },
    /** DB のタブの左の木のペイン（#348）にキーを向ける関数を受け取る（DbTree。消えるときは undefined） */
    setDbTreeFocus(f: (() => void) | undefined) {
      focusDbTree = f;
    },
    /** 木のペインにキーを向ける（描かれるのを待つ。開けた直後は、まだ画面が出ていない） */
    focusDbTree: () => queueMicrotask(() => focusDbTree?.()),
    /** URL バー（新しいタブのページなら検索窓）にキーを向ける関数を受け取る（UrlBar・NewTabPage） */
    setUrlBarFocus(f: () => void) {
      focusUrlBar = f;
    },
    focusFind: () => focusFind?.(),
    focusUrlBar: () => focusUrlBar?.(),
  };
}
