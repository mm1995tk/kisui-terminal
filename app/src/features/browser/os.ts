// 内蔵ブラウザのタブ（#202）が、外（Tauri の殻。src-tauri/src/browser.rs）に頼むこと。
// 機能と画面はこの形だけを知る。本物は infrastructure/tauri/browser.ts にあり、index.tsx が渡す。

import type { InterceptKey } from "../commands/commands.ts";
import type { KeyLike } from "../commands/guiKeys.ts";
import type { Bookmark } from "./bookmarks.ts";
import type { StoredTabs } from "./tabs.ts";

/** 画面の中の四角（CSS ピクセル。左上が原点）。タブのページを重ねる場所に使う。 */
export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * タブのページを置く場所。殻に渡す形（論理ピクセル。画面の viewport の左上が原点）。
 * `vw`・`vh` は、四角を測ったときの viewport の大きさ。殻（macOS）は、これと画面の view の枠から、viewport が窓の
 * どこにあるかを決める（src-tauri/src/browser_frame.rs。#442）。
 */
export interface Placement extends Bounds {
  vw: number;
  vh: number;
}

/** ページが新しい窓を開いた知らせ（#204）。tab は殻が付けた新しいタブの id、opener は開いた元のタブ。 */
export interface TabPopup {
  opener: string;
  tab: string;
  url: string;
}

/** ダウンロードが終わった（#204。download.rs）。id は開く・表示するときの番号（保存できなかったときは 0）。 */
export interface DownloadDone {
  id: number;
  name: string;
  dir: string;
  ok: boolean;
}

/** 知らせを聞くのをやめる関数。 */
type Off = () => void;

/**
 * `startPasskeyLogin` の答え。`opened` 待ちを覚えて外のブラウザで開いた・`no-sites` passkey_sites が無い・
 * `incognito` シークレットのタブ・`not-allowed` 許可サイトでない。
 */
export type PasskeyLogin = "opened" | "no-sites" | "incognito" | "not-allowed";

/** 内蔵ブラウザのタブについて、外（Tauri の殻）に頼むこと。タブのページ（子の webview）の操作、覚えているタブとブックマークの読み書き、ページからの知らせ、ダウンロード。 */
export interface BrowserOs {
  /**
   * タブ（子の webview）を作る。作るだけで、キーは向けない。keys は、ページにキーがあっても受けるキー（リーダーと近道）。
   * incognito はシークレットのタブ（#204。タブだけの、ディスクに残さないデータを使う）。
   * proxy は、通信を記録するプロキシ（#409）の待ち受け口（手元のマシンの 127.0.0.1 のポート）。あれば、そのタブだけの、
   * ディスクに残さないデータを使い、そのプロキシに通す webview を作る（通せなければ失敗する。macOS は 14 以降）。
   */
  openTab(
    tab: string,
    url: string,
    keys: InterceptKey[],
    incognito: boolean,
    b: Placement,
    proxy?: number,
  ): Promise<void>;
  /**
   * タブで url を開くときに、ページに実際に開かせる URL（#203。殻の open_url.rs の browser_resolve_url）。
   * `target` はタブのワークスペースのマシン。リモートのマシンの localhost 系なら、殻が `kisui relay` の中継を用意して、
   * 手元の待ち受けの URL を返す（そのポートで誰も待っていなければ失敗する）。ほかはそのまま返す。
   */
  resolveTabUrl(target: string, url: string): Promise<string>;
  /**
   * タブの位置と大きさを合わせる。窓の形が変わったときは、殻（macOS）が、次にこれを呼ぶまで、自分でページを追従させる
   * （同じ場所を送り直さなくてよい。#442）。
   */
  moveTab(tab: string, b: Placement): Promise<void>;
  /** タブを見せる・隠す（隠すと、キーは kisui-terminal の画面に戻る）。 */
  showTabView(tab: string, visible: boolean): Promise<void>;
  /** タブのページにキーを向ける。 */
  focusTab(tab: string): Promise<void>;
  /** タブで URL を開く。 */
  goTab(tab: string, url: string): Promise<void>;
  /** 戻る・進む・読み込み直す。 */
  navTab(tab: string, action: "back" | "forward" | "reload"): Promise<void>;
  /** 読み込みを止める（#449）。ページは前のまま残る。 */
  stopTab(tab: string): Promise<void>;
  /** ページの表示の大きさを変える（1 が元の大きさ。#205）。 */
  zoomTab(tab: string, zoom: number): Promise<void>;
  /**
   * ページ内を探す（#205）。mode は `first`（探す字を変えた。今の所から探し直す）・`next`・`prev`。見つかったかを返す。
   * 見つけた所はページの選択になり、そこまでスクロールする。端では折り返す。
   */
  findInTab(
    tab: string,
    text: string,
    mode: "first" | "next" | "prev",
  ): Promise<boolean>;
  /** タブのページの DevTools を開く（#205）。 */
  openTabDevtools(tab: string): Promise<void>;
  /** パスキーを待たずに、今のタブのサイトを外のブラウザで開き、そのサイトのログインを待つ（#276）。 */
  startPasskeyLogin(tab: string): Promise<PasskeyLogin>;
  /** 覚えたブックマーク（#205。すべてのワークスペースで共有）。 */
  loadBookmarks(): Promise<Bookmark[]>;
  /** Chrome のブックマーク（#239。読むだけ。Chrome が無ければ空）。 */
  loadChromeBookmarks(): Promise<unknown>;
  /** ブックマークを覚える（丸ごと置き換える）。 */
  saveBookmarks(bookmarks: readonly Bookmark[]): Promise<void>;
  /** タブを閉じる（子の webview を壊す）。 */
  closeTabView(tab: string): Promise<void>;
  /** 覚えていたタブ。 */
  loadTabs(): Promise<StoredTabs>;
  /** 開いているタブを覚える。 */
  saveTabs(data: StoredTabs): Promise<void>;
  /** ページの読み込みが始まった・終わった（URL はそのときのもの）。返す関数で聞くのをやめる。 */
  onTabPage(
    h: (e: { tab: string; url: string; loading: boolean }) => void,
  ): Promise<Off>;
  /**
   * ページの読み込みが、ページが出る前に失敗した（#432。証明書が信頼できない・名前が引けない・つながらないなど）。
   * プロキシ（#409）に通したタブで、プロキシが行き先につながらなかったときも、これが来る。
   * ページは替わらず、前のページが残る。画面は、そのタブのページを隠して、url（開こうとした URL）と理由を出す。
   * 片付けるのは onTabLoadCleared が来たとき。reason は殻の分類（loadError.ts の LoadReason）。
   */
  onTabLoadFailed(
    h: (e: {
      tab: string;
      url: string;
      reason: string;
      detail: string;
    }) => void,
  ): Promise<Off>;
  /**
   * 読み込みの失敗が終わった（#432）。次の読み込みを頼んだ（URL を開く・読み込み直す）か、ページが替わった（戻る・進むは、ページが替わったときに来る）。
   * 画面は、そのタブの失敗の表示を片付ける（頼んだ読み込みがまた失敗すれば、onTabLoadFailed が出直す）。
   */
  onTabLoadCleared(h: (e: { tab: string }) => void): Promise<Off>;
  /**
   * ページを読み込み中か・進み具合が変わった（#449。殻が OS の WebView の状態を読む。ページが出る前の、つながるまでの間も来る）。
   * progress は 0〜100。画面は、URL バーの下の端に進み具合の線を出し、↻ を「×」に替える。
   */
  onTabLoading(
    h: (e: { tab: string; loading: boolean; progress: number }) => void,
  ): Promise<Off>;
  /** 戻る先・進む先があるかが変わった（#450。殻が OS の WebView の履歴を読む）。画面は URL バーの ←・→ の見た目に使う。 */
  onTabHistory(
    h: (e: { tab: string; back: boolean; forward: boolean }) => void,
  ): Promise<Off>;
  /** ページにキーがある間に、修飾キーの無い Esc が押された（#449）。ページにも届く。読み込み中なら止めるのは画面が決める。 */
  onTabEscape(h: (e: { tab: string }) => void): Promise<Off>;
  /** ページの題が変わった。 */
  onTabTitle(h: (e: { tab: string; title: string }) => void): Promise<Off>;
  /**
   * ページの favicon を読んだ（#237）。icon は 32×32 の PNG の data: URL（殻が形を確かめたもの）。取れなければ ""。
   * ページの読み込みが始まったら、画面は前の favicon を消す（殻は前のページの答えを捨てる）。
   */
  onTabFavicon(h: (e: { tab: string; icon: string }) => void): Promise<Off>;
  /** ページにキーがあるときに、リーダーか近道が押された（殻がキーを kisui-terminal の画面に移してから届く）。 */
  onTabKey(h: (e: KeyLike & { tab: string }) => void): Promise<Off>;
  /**
   * ページが新しい窓（`target=_blank` のリンク・`window.open`）を開いた（#204）。殻はもう webview を作ってある。
   * 画面は、開いた元のタブと同じワークスペースに、新しいタブとして足す。
   */
  onTabPopup(h: (e: TabPopup) => void): Promise<Off>;
  /** ページが自分を閉じた（`window.close()`。#204）。 */
  onTabClosed(h: (e: { tab: string }) => void): Promise<Off>;
  /** ダウンロードが終わった。 */
  onDownload(h: (e: DownloadDone) => void): Promise<Off>;
  /**
   * 外のブラウザから写した Cookie（パスキー。#206）が、渡したとおりの属性で内蔵ブラウザに入らなかった（#476）。
   * problems は食い違い 1 つごとの行（Cookie の名前・domain・path と、どの属性がどう違うか。値は含まない）。
   */
  onCookieMismatch(h: (problems: string[]) => void): Promise<Off>;
  /** ダウンロードしたファイルを、OS の既定のアプリで開く。 */
  openDownload(id: number): Promise<void>;
  /** ダウンロードしたファイルのフォルダを表示する。 */
  revealDownload(id: number): Promise<void>;
  /**
   * 重なりもの（お知らせ・リーダーの案内・キャラクター・メニュー）を、ページを縮めずにページの上に重ねられるかを殻に聞く（macOS だけ true）。
   * true のとき、殻は画面（メインの webview）の背景を透明にする。
   */
  enableOverlay(): Promise<boolean>;
  /**
   * 前に出すものを決める。overlay なら画面（キーも画面に向く）、そうでなければタブのページ。
   * enableOverlay が true のときだけ呼ぶ。
   */
  layerTab(tab: string, overlay: boolean): Promise<void>;
}
