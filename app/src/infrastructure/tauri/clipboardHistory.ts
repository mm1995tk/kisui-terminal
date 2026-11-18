// クリップボードの履歴（#54）と、kisui-terminal の外から開く履歴の窓（#95）の、Tauri の殻の命令と知らせ。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  ClipboardPopupOs,
  HistoryEntry,
  ListClipboardHistory,
} from "../../features/clipboard/history.ts";

/** Rust 側（clipboard_history.rs）が持つ履歴。新しいものが先頭。 */
export const listClipboardHistory: ListClipboardHistory = async () =>
  (await invoke("clipboard_history_list")) as HistoryEntry[];

/** ClipboardPopupOs の本物（clipboard_popup.rs）。 */
export const tauriClipboardPopup: ClipboardPopupOs = {
  onShown: (h) => listen("clipboard-history-shown", () => h()),
  dismiss: () => invoke("clipboard_popup_dismiss"),
  copy: (text) => invoke("clipboard_popup_copy", { text }),
};
