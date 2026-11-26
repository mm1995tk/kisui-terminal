// BrowserOs（features/browser/os.ts）の本物。内蔵ブラウザのタブ（#202）の、Tauri の殻（src-tauri/src/browser.rs）の命令と知らせ。
// それぞれが何をするかは、BrowserOs の説明にある。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { KeyLike } from "../../features/commands/guiKeys.ts";
import type {
  BrowserOs,
  DownloadDone,
  TabPopup,
} from "../../features/browser/os.ts";

/** BrowserOs の本物。殻の `browser_*`・`download_*` の命令と `browser-*` の知らせを呼ぶ。 */
export const tauriBrowser: BrowserOs = {
  openTab: (tab, url, keys, incognito, b, proxy) =>
    invoke("browser_open", {
      tab,
      url,
      keys,
      incognito,
      proxy: proxy ?? null,
      ...b,
    }),
  resolveTabUrl: (target, url) =>
    invoke("browser_resolve_url", { target, url }),
  moveTab: (tab, b) => invoke("browser_bounds", { tab, ...b }),
  showTabView: (tab, visible) => invoke("browser_visible", { tab, visible }),
  focusTab: (tab) => invoke("browser_focus", { tab }),
  goTab: (tab, url) => invoke("browser_go", { tab, url }),
  navTab: (tab, action) => invoke("browser_nav", { tab, action }),
  stopTab: (tab) => invoke("browser_stop", { tab }),
  zoomTab: (tab, zoom) => invoke("browser_zoom", { tab, zoom }),
  findInTab: (tab, text, mode) => invoke("browser_find", { tab, text, mode }),
  openTabDevtools: (tab) => invoke("browser_devtools", { tab }),
  startPasskeyLogin: (tab) => invoke("browser_passkey_login", { tab }),
  loadBookmarks: () => invoke("browser_bookmarks_load"),
  loadChromeBookmarks: () => invoke("browser_chrome_bookmarks_load"),
  saveBookmarks: (bookmarks) => invoke("browser_bookmarks_save", { bookmarks }),
  closeTabView: (tab) => invoke("browser_close", { tab }),
  loadTabs: () => invoke("browser_tabs_load"),
  saveTabs: (data) => invoke("browser_tabs_save", { data }),
  onTabPage: (h) =>
    listen<{ tab: string; url: string; loading: boolean }>(
      "browser-page",
      (e) => h(e.payload),
    ),
  onTabLoadFailed: (h) =>
    listen<{ tab: string; url: string; reason: string; detail: string }>(
      "browser-load-failed",
      (e) => h(e.payload),
    ),
  onTabLoadCleared: (h) =>
    listen<{ tab: string }>("browser-load-cleared", (e) => h(e.payload)),
  onTabLoading: (h) =>
    listen<{ tab: string; loading: boolean; progress: number }>(
      "browser-loading",
      (e) => h(e.payload),
    ),
  onTabHistory: (h) =>
    listen<{ tab: string; back: boolean; forward: boolean }>(
      "browser-history",
      (e) => h(e.payload),
    ),
  onTabEscape: (h) =>
    listen<{ tab: string }>("browser-escape", (e) => h(e.payload)),
  onTabTitle: (h) =>
    listen<{ tab: string; title: string }>("browser-title", (e) =>
      h(e.payload),
    ),
  onTabFavicon: (h) =>
    listen<{ tab: string; icon: string }>("browser-favicon", (e) =>
      h(e.payload),
    ),
  onTabKey: (h) =>
    listen<KeyLike & { tab: string }>("browser-key", (e) => h(e.payload)),
  onTabPopup: (h) => listen<TabPopup>("browser-popup", (e) => h(e.payload)),
  onTabClosed: (h) =>
    listen<{ tab: string }>("browser-closed", (e) => h(e.payload)),
  onDownload: (h) =>
    listen<DownloadDone>("browser-download", (e) => h(e.payload)),
  onCookieMismatch: (h) =>
    listen<string[]>("browser-cookie-mismatch", (e) => h(e.payload)),
  openDownload: (id) => invoke("download_open", { id }),
  revealDownload: (id) => invoke("download_reveal", { id }),
  enableOverlay: () => invoke("browser_overlay_enable"),
  layerTab: (tab, overlay) => invoke("browser_layer", { tab, overlay }),
};
