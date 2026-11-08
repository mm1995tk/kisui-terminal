import { invoke } from "@tauri-apps/api/core";

import type { HistoryEntry } from "./clipboardHistory.ts";

/** Rust 側（clipboard_history.rs）が持つ履歴。新しいものが先頭。 */
export async function listClipboardHistory(): Promise<HistoryEntry[]> {
  return (await invoke("clipboard_history_list")) as HistoryEntry[];
}
