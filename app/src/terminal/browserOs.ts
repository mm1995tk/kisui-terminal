// ブラウザの欄（#556）の、Tauri の殻（src-tauri/src/browser.rs）の命令と通知。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { Bounds } from "./browser.ts";

/** 子の webview（欄の中身）を作る。リモートのマシンの localhost 系は、殻が ssh のポート転送越しに開く。 */
export function openBrowser(
  key: string,
  target: string,
  url: string,
  b: Bounds,
): Promise<void> {
  return invoke("browser_open", { key, target, url, ...b });
}

/** 子の webview の位置と大きさを合わせる。 */
export function moveBrowser(key: string, b: Bounds): Promise<void> {
  return invoke("browser_bounds", { key, ...b });
}

/** 子の webview を見せる・隠す。 */
export function showBrowser(key: string, visible: boolean): Promise<void> {
  return invoke("browser_visible", { key, visible });
}

/** 開いている欄で URL を開く（リモートのマシンの localhost 系は転送越し）。 */
export function goBrowser(
  key: string,
  target: string,
  url: string,
): Promise<void> {
  return invoke("browser_go", { key, target, url });
}

/** 戻る・進む・再読み込み。 */
export function navBrowser(
  key: string,
  action: "back" | "forward" | "reload",
): Promise<void> {
  return invoke("browser_nav", { key, action });
}

/** 子の webview を壊し、その欄の転送も止める。 */
export function closeBrowser(key: string): Promise<void> {
  return invoke("browser_close", { key });
}

/** 欄の中のページが変わったとき（読み込み開始・終了）の URL。返す関数で聞くのをやめる。 */
export async function onBrowserUrl(
  key: string,
  h: (url: string) => void,
): Promise<() => void> {
  return listen<{ key: string; url: string }>("browser-url", (e) => {
    if (e.payload.key === key) h(e.payload.url);
  });
}

/** いま開いているページを、手元の既定のブラウザで開き直す（パスキーなど、欄では使えないものの逃がし道）。 */
export function openExternally(key: string): Promise<void> {
  return invoke("browser_external", { key });
}

/** ターミナルの URL を手元の既定のブラウザで開く（#47。殻が http と https 以外を断る）。 */
export function openUrlExternally(url: string): Promise<void> {
  return invoke("open_url_external", { url });
}

/** 設定ファイルの `[gui] url_open`（`cmd + shift + click` で開く先。初期値は external）。間違いがあれば「ファイル:行: 理由」で失敗する。 */
export function urlOpenSetting(): Promise<"external" | "builtin"> {
  return invoke("config_url_open");
}
