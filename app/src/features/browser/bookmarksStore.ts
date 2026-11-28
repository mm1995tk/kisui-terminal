// 内蔵ブラウザのブックマーク（#205）の持ち物。すべてのワークスペースで共有し、殻がデータのフォルダに覚える（bookmarks.ts）。
// Firefox のブックマーク（#543）は読むだけ。
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
  firefoxProblemFromLoaded,
  firefoxProblemKey,
  fromLoaded as bookmarksFromLoaded,
  removeBookmark,
  type Bookmark,
  type FirefoxProblem,
} from "./bookmarks.ts";
import {
  firefoxTreeFromLoaded,
  countFirefox,
  type FirefoxNode,
} from "./bookmarkTree.ts";
import type { BrowserOs } from "./os.ts";
import type { BrowserTab } from "./tabs.ts";

/** createBookmarks が返す持ち物。 */
export type Bookmarks = ReturnType<typeof createBookmarks>;

/** ブックマークの持ち物を作る。自分のブックマークと Firefox のブックマークを読み、足す・消す・開く・一覧の Dialog の開け閉めを受け持つ。 */
export function createBookmarks(deps: {
  os: Pick<
    BrowserOs,
    "loadBookmarks" | "loadFirefoxBookmarks" | "saveBookmarks"
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
  const { loadBookmarks, loadFirefoxBookmarks, saveBookmarks } = deps.os;
  /** ブックマーク（新しく足したものが先）。読み終えるまでは undefined */
  const [bookmarks, setBookmarks] = createSignal<Bookmark[] | undefined>();
  const [bookmarksFailed, setBookmarksFailed] = createSignal(false);
  /** Firefox のブックマークの木（#239。#275 でフォルダの入れ子のまま持つ。読むだけ。無い・読めないときは空） */
  const [firefoxBookmarks, setFirefoxBookmarks] = createSignal<
    FirefoxNode[] | undefined
  >();
  /** Firefox のブックマークの数（自身のものが読めなかったときの案内に使う） */
  const firefoxCount = createMemo(() => countFirefox(firefoxBookmarks() ?? []));
  /** ブックマークの一覧のダイアログ（ブラウザのタブの Dialog の B）を出しているか */
  const [bookmarkDialog, setBookmarkDialog] = createSignal(false);
  /** 最後に知らせた、Firefox のブックマークを読めなかった理由（#265。同じ理由を開くたびに知らせない。読めたら忘れる） */
  let lastFirefoxProblem: string | undefined;
  /** Firefox のブックマークを読めなかった理由を、前に知らせたものと違うときだけ Notice に出す（#265。開くたびに読み直すので、続けては知らせない）。読めたら忘れる。 */
  function notifyFirefoxProblem(problem: FirefoxProblem | undefined) {
    if (!problem) {
      lastFirefoxProblem = undefined;
      return;
    }
    const key = firefoxProblemKey(problem);
    if (key === lastFirefoxProblem) return;
    lastFirefoxProblem = key;
    showToast(
      T(
        problem.needsPermission
          ? "err.bookmarks.firefoxPermission"
          : "err.bookmarks.firefox",
        { reason: problem.reason, path: problem.path },
      ),
    );
  }
  /** Firefox のブックマークを読み直す（#239。Firefox で足し・消しした分が反映される。Firefox が動いていても読める）。命令が失敗したときと、読めなかったとき（#265）は前のまま（無ければ空）。 */
  function readFirefoxBookmarks() {
    loadFirefoxBookmarks().then(
      (v) => {
        const first = untrack(firefoxBookmarks) === undefined;
        const problem = firefoxProblemFromLoaded(v);
        notifyFirefoxProblem(problem);
        const list = firefoxTreeFromLoaded(v);
        if (!problem || first) setFirefoxBookmarks(list);
        // 自分のものの読み込みが先に失敗していたら、Firefox のものが届いたここで知らせる（読み終わる順に依らないように）
        if (first && countFirefox(list) > 0 && untrack(bookmarksFailed))
          showToast(T("err.bookmarks.read"));
      },
      (e: unknown) => {
        console.warn("firefox bookmarks:", e);
        if (untrack(firefoxBookmarks) === undefined) setFirefoxBookmarks([]);
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
        // 一覧には Firefox のものが出るので、自分のものが読めなかったことは別に知らせる（#239）
        if (untrack(firefoxCount) > 0) showToast(T("err.bookmarks.read"));
        throw e;
      },
    );
  }
  /**
   * ブックマークを書き換えて覚える。書けたら onSaved を呼ぶ。書けなければ前の一覧に戻して onFailed を呼ぶ（既定は画面に出す）
   * （書けないものを一覧に残すと、画面とファイルが食い違い、その後の保存もすべて失敗するため）。
   */
  function changeBookmarks(
    next: Bookmark[],
    onSaved?: () => void,
    onFailed: (e: unknown) => void = (e) =>
      setFocusError({
        title: T("err.bookmarks.save"),
        error: e instanceof Error ? e.message : String(e),
      }),
  ) {
    const prev = untrack(bookmarks);
    setBookmarks(next);
    saveBookmarks(next).then(
      () => onSaved?.(),
      (e: unknown) => {
        // 書いている間に、ほかの操作がまた書き換えていれば、そちらを残す
        if (untrack(bookmarks) === next) setBookmarks(prev);
        onFailed(e);
      },
    );
  }
  /** 今のページをブックマークに足す（ブラウザのタブの Dialog の b）。読む前なら、先に読んでから足す（覚えていたものを消さないため）。 */
  function bookmarkPage(t: BrowserTab) {
    const fail = (e: unknown) =>
      setFocusError({
        title: T("err.bookmarks.save"),
        error: e instanceof Error ? e.message : String(e),
      });
    bookmarkPageChecked(t).catch(fail);
  }
  /** bookmarkPage と同じに足す。足せなければ、画面に出さず、理由で断る（`kisui browser bookmark add`。#515）。足し終えたら解く。 */
  async function bookmarkPageChecked(t: BrowserTab): Promise<void> {
    const list = untrack(bookmarks) ?? (await readBookmarks());
    await new Promise<void>((done, fail) =>
      changeBookmarks(
        addBookmark(list, { url: t.url, title: t.title }),
        () => {
          showToast(T("toast.bookmarked"));
          done();
        },
        fail,
      ),
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
        readFirefoxBookmarks();
        readBookmarks().catch(() => {});
      }
    }),
  );

  return {
    /** ブックマーク（新しく足したものが先）。読み終えるまでは undefined */
    bookmarks,
    /** Firefox のブックマークの木（読み終えるまでは undefined） */
    firefoxBookmarks,
    /** 自分のブックマークも Firefox のものも出せないか（読めなかったと出す） */
    failed: () => bookmarksFailed() && firefoxCount() === 0,
    /** ブックマークの一覧のダイアログ（ブラウザのタブの Dialog の B）を出しているか */
    bookmarkDialog,
    /** 一覧のダイアログを出す。開くたびに読み直す（読めなければ、前に読んだものを出す） */
    openDialog() {
      setBookmarkDialog(true);
      readFirefoxBookmarks();
      readBookmarks().catch(() => {});
    },
    /** 一覧のダイアログを閉じ、キーをページ（ターミナル）に戻す */
    closeDialog() {
      setBookmarkDialog(false);
      focusTerminal();
    },
    bookmarkPage,
    bookmarkPageChecked,
    /** 覚えているブックマークを読み直して返す（Firefox のものは含めない。`kisui browser bookmark list`。#515）。読めなければ断る */
    readBookmarks,
    openBookmark,
    /** 一覧で消す。Firefox のブックマークは消せない（読むだけ。#543） */
    deleteBookmark(b: Bookmark) {
      if (b.source === "firefox") showToast(T("toast.bookmarks.firefoxKept"));
      else changeBookmarks(removeBookmark(bookmarks() ?? [], b.url));
    },
  };
}
