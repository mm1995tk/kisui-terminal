// 内蔵ブラウザのタブ（#202）の、Tauri の殻（src-tauri/src/browser.rs）の命令と知らせ。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { InterceptKey } from "../commands.ts";
import type { KeyLike } from "../guiKeys.ts";
import type { Bookmark } from "./bookmarks.ts";
import type { Bounds } from "./overlay.ts";
import type { StoredTabs } from "./tabs.ts";

/**
 * タブ（子の webview）を作る。作るだけで、キーは向けない。keys は、ページにキーがあっても受けるキー（リーダーと近道）。
 * incognito はシークレットのタブ（#204。タブだけの、ディスクに残さないデータを使う）。
 */
export function openTab(
  tab: string,
  url: string,
  keys: InterceptKey[],
  incognito: boolean,
  b: Bounds,
): Promise<void> {
  return invoke("browser_open", { tab, url, keys, incognito, ...b });
}

/**
 * タブで url を開くときに、ページに実際に開かせる URL（#203。殻の open_url.rs の browser_resolve_url）。
 * `target` はタブのワークスペースのマシン。リモートのマシンの localhost 系なら、殻が `kisui relay` の中継を用意して、
 * 手元の待ち受けの URL を返す（そのポートで誰も待っていなければ失敗する）。ほかはそのまま返す。
 */
export function resolveTabUrl(target: string, url: string): Promise<string> {
  return invoke("browser_resolve_url", { target, url });
}

/** タブの位置と大きさを合わせる（論理ピクセル）。 */
export function moveTab(tab: string, b: Bounds): Promise<void> {
  return invoke("browser_bounds", { tab, ...b });
}

/** タブを見せる・隠す（隠すと、キーは kisui-terminal の画面に戻る）。 */
export function showTabView(tab: string, visible: boolean): Promise<void> {
  return invoke("browser_visible", { tab, visible });
}

/** タブのページにキーを向ける。 */
export function focusTab(tab: string): Promise<void> {
  return invoke("browser_focus", { tab });
}

/** タブで URL を開く。 */
export function goTab(tab: string, url: string): Promise<void> {
  return invoke("browser_go", { tab, url });
}

/** 戻る・進む・読み込み直す。 */
export function navTab(
  tab: string,
  action: "back" | "forward" | "reload",
): Promise<void> {
  return invoke("browser_nav", { tab, action });
}

/** ページの表示の大きさを変える（1 が元の大きさ。#205）。 */
export function zoomTab(tab: string, zoom: number): Promise<void> {
  return invoke("browser_zoom", { tab, zoom });
}

/**
 * ページ内を探す（#205）。mode は `first`（探す字を変えた。今の所から探し直す）・`next`・`prev`。見つかったかを返す。
 * 見つけた所はページの選択になり、そこまでスクロールする。端では折り返す。
 */
export function findInTab(
  tab: string,
  text: string,
  mode: "first" | "next" | "prev",
): Promise<boolean> {
  return invoke("browser_find", { tab, text, mode });
}

/** タブのページの DevTools を開く（#205）。 */
export function openTabDevtools(tab: string): Promise<void> {
  return invoke("browser_devtools", { tab });
}

/** 覚えたブックマーク（#205。すべてのワークスペースで共有）。 */
export function loadBookmarks(): Promise<Bookmark[]> {
  return invoke("browser_bookmarks_load");
}

/** ブックマークを覚える（丸ごと置き換える）。 */
export function saveBookmarks(bookmarks: readonly Bookmark[]): Promise<void> {
  return invoke("browser_bookmarks_save", { bookmarks });
}

/** タブを閉じる（子の webview を壊す）。 */
export function closeTabView(tab: string): Promise<void> {
  return invoke("browser_close", { tab });
}

/** 覚えていたタブ。 */
export function loadTabs(): Promise<StoredTabs> {
  return invoke("browser_tabs_load");
}

/** 開いているタブを覚える。 */
export function saveTabs(data: StoredTabs): Promise<void> {
  return invoke("browser_tabs_save", { data });
}

/** ページの読み込みが始まった・終わった（URL はそのときのもの）。返す関数で聞くのをやめる。 */
export function onTabPage(
  h: (e: { tab: string; url: string; loading: boolean }) => void,
): Promise<() => void> {
  return listen<{ tab: string; url: string; loading: boolean }>(
    "browser-page",
    (e) => h(e.payload),
  );
}

/** ページの題が変わった。 */
export function onTabTitle(
  h: (e: { tab: string; title: string }) => void,
): Promise<() => void> {
  return listen<{ tab: string; title: string }>("browser-title", (e) =>
    h(e.payload),
  );
}

/** ページにキーがあるときに、リーダーか近道が押された（殻がキーを kisui-terminal の画面に移してから届く）。 */
export function onTabKey(
  h: (e: KeyLike & { tab: string }) => void,
): Promise<() => void> {
  return listen<KeyLike & { tab: string }>("browser-key", (e) => h(e.payload));
}

/** ページが新しい窓を開いた知らせ（#204）。tab は殻が付けた新しいタブの id、opener は開いた元のタブ。 */
export interface TabPopup {
  opener: string;
  tab: string;
  url: string;
}

/**
 * ページが新しい窓（`target=_blank` のリンク・`window.open`）を開いた（#204）。殻はもう webview を作ってある。
 * 画面は、開いた元のタブと同じワークスペースに、新しいタブとして足す。
 */
export function onTabPopup(h: (e: TabPopup) => void): Promise<() => void> {
  return listen<TabPopup>("browser-popup", (e) => h(e.payload));
}

/** ページが自分を閉じた（`window.close()`。#204）。 */
export function onTabClosed(
  h: (e: { tab: string }) => void,
): Promise<() => void> {
  return listen<{ tab: string }>("browser-closed", (e) => h(e.payload));
}

/** ダウンロードが終わった（#204。download.rs）。id は開く・表示するときの番号（保存できなかったときは 0）。 */
export interface DownloadDone {
  id: number;
  name: string;
  dir: string;
  ok: boolean;
}

/** ダウンロードが終わった。 */
export function onDownload(h: (e: DownloadDone) => void): Promise<() => void> {
  return listen<DownloadDone>("browser-download", (e) => h(e.payload));
}

/** ダウンロードしたファイルを、OS の既定のアプリで開く。 */
export function openDownload(id: number): Promise<void> {
  return invoke("download_open", { id });
}

/** ダウンロードしたファイルのフォルダを表示する。 */
export function revealDownload(id: number): Promise<void> {
  return invoke("download_reveal", { id });
}
