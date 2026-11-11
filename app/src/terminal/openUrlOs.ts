// URL を手元の外部ブラウザで開く（#96）、Tauri の殻（src-tauri/src/open_url.rs）の命令。

import { invoke } from "@tauri-apps/api/core";

/**
 * URL を、手元の OS 既定のブラウザで開く。`target` はその URL が見えているマシン（「ローカル」の `@local` か ssh の宛先）。
 * リモートのマシンの localhost 系の URL は、殻が ssh のポート転送を張り、転送越しの URL で開く。
 */
export function openUrlExternally(target: string, url: string): Promise<void> {
  return invoke("open_url_external", { target, url });
}
