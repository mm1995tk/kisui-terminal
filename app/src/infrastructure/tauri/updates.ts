// UpdatesOs（features/updates/store.ts）の本物。新しい版を調べる・入れ替えるのは殻（src-tauri/src/update.rs）。
import { invoke } from "@tauri-apps/api/core";

import type { UpdatesOs } from "../../features/updates/store.ts";

export const tauriUpdates: UpdatesOs = {
  check: () => invoke("update_check"),
  checkNow: () => invoke("update_check_now"),
  install: () => invoke("update_install"),
};
