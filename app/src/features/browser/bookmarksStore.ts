// 内蔵ブラウザのブックマーク（#205）の持ち物。すべてのワークスペースで共有し、殻がデータのフォルダに覚える（bookmarks.ts）。
// Chrome のブックマーク（#239）は読むだけ。
// 画面にも Tauri にも触らない。殻への頼みは BrowserOs（os.ts）で受け取り、短い知らせは showToast に頼む。
import { T } from "../../i18n/index.ts";
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  untrack,
  type Accessor,
} from "solid-js";

import type { ReportProblem } from "../problem.ts";
import {
  addBookmark,
  chromeProblemFromLoaded,
  chromeProblemKey,
  fromLoaded as bookmarksFromLoaded,
  removeBookmark,
  type Bookmark,
  type ChromeProblem,
} from "./bookmarks.ts";
import {
  chromeTreeFromLoaded,
  countChrome,
  type ChromeNode,
} from "./bookmarkTree.ts";
import type { BrowserOs } from "./os.ts";
import type { BrowserTab } from "./tabs.ts";

/** createBookmarks が返す持ち物。 */
export type Bookmarks = ReturnType<typeof createBookmarks>;

/** ブックマークの持ち物を作る。自分のブックマークと Chrome のブックマークを読み、足す・消す・開く・一覧の Dialog の開け閉めを受け持つ。 */
export function createBookmarks(deps: {
  os: Pick<
    BrowserOs,
    "loadBookmarks" | "loadChromeBookmarks" | "saveBookmarks"
  >;
  /** 今いる GUI のワークスペースに、ページ url の新しいブラウザのタブを開いて出す。今いるワークスペースが無ければ開かずに false（features/workspaces/tabs/controller.ts の openBrowserTab） */
  openTab: (url: string, title: string) => boolean;
  /** 出しているタブのうち、新しいタブのページ（#238）の id（出すたびにブックマークを読み直す） */
  newTabPageId: Accessor<string | undefined>;
  /** 少しの間だけ出る短い知らせ */
  showToast: (text: string) => void;
  setFocusError: ReportProblem;
  /** できないことを知らせる */
  cannot: (title: string, error: string) => void;
  focusTerminal: () => void;
}) {
  const {
    openTab,
    newTabPageId,
    showToast,
    setFocusError,
    cannot,
    focusTerminal,
  } = deps;
  const { loadBookmarks, loadChromeBookmarks, saveBookmarks } = deps.os;
  /** ブックマーク（新しく足したものが先）。読み終えるまでは undefined */
  const [bookmarks, setBookmarks] = createSignal<Bookmark[] | undefined>();
  const [bookmarksFailed, setBookmarksFailed] = createSignal(false);
  /** Chrome のブックマークの木（#239。#275 でフォルダの入れ子のまま持つ。読むだけ。無い・読めないときは空） */
  const [chromeBookmarks, setChromeBookmarks] = createSignal<
    ChromeNode[] | undefined
  >();
  /** Chrome のブックマークの数（自身のものが読めなかったときの案内に使う） */
  const chromeCount = createMemo(() => countChrome(chromeBookmarks() ?? []));
  /** ブックマークの一覧のダイアログ（ブラウザのタブの Dialog の B）を出しているか */
  const [bookmarkDialog, setBookmarkDialog] = createSignal(false);
  /** 最後に知らせた、Chrome のブックマークを読めなかった理由（#265。同じ理由を開くたびに知らせない。読めたら忘れる） */
  let lastChromeProblem: string | undefined;
  /** Chrome のブックマークを読めなかった理由を、前に知らせたものと違うときだけ Notice に出す（#265。開くたびに読み直すので、続けては知らせない）。読めたら忘れる。 */
  function notifyChromeProblem(problem: ChromeProblem | undefined) {
    if (!problem) {
      lastChromeProblem = undefined;
      return;
    }
    const key = chromeProblemKey(problem);
    if (key === lastChromeProblem) return;
    lastChromeProblem = key;
    showToast(
      T(
        problem.needsPermission
          ? "err.bookmarks.chromePermission"
          : "err.bookmarks.chrome",
        { reason: problem.reason, path: problem.path },
      ),
    );
  }
  /** Chrome のブックマークを読み直す（#239。Chrome で足し・消しした分が反映される）。命令が失敗したときと、読めなかったとき（#265）は前のまま（無ければ空）。 */
  function readChromeBookmarks() {
    loadChromeBookmarks().then(
      (v) => {
        const first = untrack(chromeBookmarks) === undefined;
        const problem = chromeProblemFromLoaded(v);
        notifyChromeProblem(problem);
        const list = chromeTreeFromLoaded(v);
        if (!problem || first) setChromeBookmarks(list);
        // 自分のものの読み込みが先に失敗していたら、Chrome のものが届いたここで知らせる（読み終わる順に依らないように）
        if (first && countChrome(list) > 0 && untrack(bookmarksFailed))
          showToast(T("err.bookmarks.read"));
      },
      (e: unknown) => {
        console.warn("chrome bookmarks:", e);
        if (untrack(chromeBookmarks) === undefined) setChromeBookmarks([]);
      },
    );
  }
  /** 覚えているブックマークを読む（一覧を開くたびと、初めて足すとき。読めなければ前のまま）。 */
  function readBookmarks(): Promise<Bookmark[]> {
    return loadBookmarks().then(
      (v) => {
        const list = bookmarksFromLoaded(v);
        setBookmarks(list);
        setBookmarksFailed(false);
        return list;
      },
      (e: unknown) => {
        console.warn("bookmarks:", e);
        if (untrack(bookmarks) === undefined) setBookmarksFailed(true);
        // 一覧には Chrome のものが出るので、自分のものが読めなかったことは別に知らせる（#239）
        if (untrack(chromeCount) > 0) showToast(T("err.bookmarks.read"));
        throw e;
      },
    );
  }
  /**
   * ブックマークを書き換えて覚える。書けたら onSaved を呼ぶ。書けなければ前の一覧に戻して知らせる
   * （書けないものを一覧に残すと、画面とファイルが食い違い、その後の保存もすべて失敗するため）。
   */
  function changeBookmarks(next: Bookmark[], onSaved?: () => void) {
    const prev = untrack(bookmarks);
    setBookmarks(next);
    saveBookmarks(next).then(
      () => onSaved?.(),
      (e: unknown) => {
        // 書いている間に、ほかの操作がまた書き換えていれば、そちらを残す
        if (untrack(bookmarks) === next) setBookmarks(prev);
        setFocusError({
          title: T("err.bookmarks.save"),
          error: e instanceof Error ? e.message : String(e),
        });
      },
    );
  }
  /** 今のページをブックマークに足す（ブラウザのタブの Dialog の b）。読む前なら、先に読んでから足す（覚えていたものを消さないため）。 */
  function bookmarkPage(t: BrowserTab) {
    const add = (list: Bookmark[]) =>
      changeBookmarks(addBookmark(list, { url: t.url, title: t.title }), () =>
        showToast(T("toast.bookmarked")),
      );
    const had = bookmarks();
    if (had) add(had);
    else
      readBookmarks().then(add, (e: unknown) =>
        setFocusError({
          title: T("err.bookmarks.save"),
          error: e instanceof Error ? e.message : String(e),
        }),
      );
  }
  /** ブックマークを今のワークスペースの新しいタブで開く（一覧の Enter）。 */
  function openBookmark(b: Bookmark) {
    setBookmarkDialog(false);
    // 開く先は今いるワークスペース（ターミナルのタブが無いワークスペースでも。#307）。開いたところのマシンは、そのワークスペースのタブから決まる
    if (!openTab(b.url, b.title)) {
      cannot(T("cannot.browser.open.title"), T("cannot.browser.open.text"));
      return;
    }
    focusTerminal();
  }

  // 新しいタブのページ（#238）を出すたびに、ブックマークを読み直す（読めなければ、前に読んだものを出す）
  createEffect(
    on(newTabPageId, (id) => {
      if (id !== undefined) {
        readChromeBookmarks();
        readBookmarks().catch(() => {});
      }
    }),
  );

  return {
    /** ブックマーク（新しく足したものが先）。読み終えるまでは undefined */
    bookmarks,
    /** Chrome のブックマークの木（読み終えるまでは undefined） */
    chromeBookmarks,
    /** 自分のブックマークも Chrome のものも出せないか（読めなかったと出す） */
    failed: () => bookmarksFailed() && chromeCount() === 0,
    /** ブックマークの一覧のダイアログ（ブラウザのタブの Dialog の B）を出しているか */
    bookmarkDialog,
    /** 一覧のダイアログを出す。開くたびに読み直す（読めなければ、前に読んだものを出す） */
    openDialog() {
      setBookmarkDialog(true);
      readChromeBookmarks();
      readBookmarks().catch(() => {});
    },
    /** 一覧のダイアログを閉じ、キーをページ（ターミナル）に戻す */
    closeDialog() {
      setBookmarkDialog(false);
      focusTerminal();
    },
    bookmarkPage,
    openBookmark,
    /** 一覧で消す。Chrome のブックマークは消せない（読むだけ。#239） */
    deleteBookmark(b: Bookmark) {
      if (b.source === "chrome") showToast(T("toast.bookmarks.chromeKept"));
      else changeBookmarks(removeBookmark(bookmarks() ?? [], b.url));
    },
  };
}
