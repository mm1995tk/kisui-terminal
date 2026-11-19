// KeyValueStore（features/keyValueStore.ts）の本物。webview の localStorage（Tauri のアプリごとに残る）。
import type { KeyValueStore } from "../../features/keyValueStore.ts";

/** 本物の localStorage（使えない環境では undefined）。 */
export function browserStore(): KeyValueStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
