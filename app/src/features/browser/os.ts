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

export interface BrowserOs {
  /**
   * タブ（子の webview）を作る。作るだけで、キーは向けない。keys は、ページにキーがあっても受けるキー（リーダーと近道）。
   * incognito はシークレットのタブ（#204。タブだけの、ディスクに残さないデータを使う）。
   */
  openTab(
    tab: string,
    url: string,
    keys: InterceptKey[],
    incognito: boolean,
    b: Bounds,
  ): Promise<void>;
  /**
   * タブで url を開くときに、ページに実際に開かせる URL（#203。殻の open_url.rs の browser_resolve_url）。
   * `target` はタブのワークスペースのマシン。リモートのマシンの localhost 系なら、殻が `kisui relay` の中継を用意して、
   * 手元の待ち受けの URL を返す（そのポートで誰も待っていなければ失敗する）。ほかはそのまま返す。
   */
  resolveTabUrl(target: string, url: string): Promise<string>;
  /** タブの位置と大きさを合わせる（論理ピクセル）。 */
  moveTab(tab: string, b: Bounds): Promise<void>;
  /** タブを見せる・隠す（隠すと、キーは kisui-terminal の画面に戻る）。 */
  showTabView(tab: string, visible: boolean): Promise<void>;
  /** タブのページにキーを向ける。 */
  focusTab(tab: string): Promise<void>;
  /** タブで URL を開く。 */
  goTab(tab: string, url: string): Promise<void>;
  /** 戻る・進む・読み込み直す。 */
  navTab(tab: string, action: "back" | "forward" | "reload"): Promise<void>;
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
  /** ダウンロードしたファイルを、OS の既定のアプリで開く。 */
  openDownload(id: number): Promise<void>;
  /** ダウンロードしたファイルのフォルダを表示する。 */
  revealDownload(id: number): Promise<void>;
  /**
   * 重なりもの（リーダーの案内・キャラクター・メニュー）を、ページを縮めずにページの上に重ねられるかを殻に聞く（macOS だけ true）。
   * true のとき、殻は画面（メインの webview）の背景を透明にする。
   */
  enableOverlay(): Promise<boolean>;
  /**
   * 前に出すものを決める。overlay なら画面（キーも画面に向く）、そうでなければタブのページ。
   * enableOverlay が true のときだけ呼ぶ。
   */
  layerTab(tab: string, overlay: boolean): Promise<void>;
}
