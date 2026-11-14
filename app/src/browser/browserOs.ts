// 内蔵ブラウザのタブ（#202）の、Tauri の殻（src-tauri/src/browser.rs）の命令と知らせ。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { InterceptKey } from "../commands.ts";
import type { KeyLike } from "../guiKeys.ts";
import type { Bounds } from "./overlay.ts";
import type { StoredTabs } from "./tabs.ts";

/** タブ（子の webview）を作る。作るだけで、キーは向けない。keys は、ページにキーがあっても受けるキー（リーダーと近道）。 */
export function openTab(
  tab: string,
  url: string,
  keys: InterceptKey[],
  b: Bounds,
): Promise<void> {
  return invoke("browser_open", { tab, url, keys, ...b });
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
