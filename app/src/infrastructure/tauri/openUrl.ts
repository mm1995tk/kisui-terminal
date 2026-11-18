// URL を手元の外部ブラウザで開く（#96）、Tauri の殻（src-tauri/src/open_url.rs）の命令。

import { invoke } from "@tauri-apps/api/core";

import type { OpenUrlExternally } from "../../features/terminal/urlOpen.ts";

/** OpenUrlExternally（features/terminal/urlOpen.ts）の本物。 */
export const openUrlExternally: OpenUrlExternally = (target, url) =>
  invoke("open_url_external", { target, url });
