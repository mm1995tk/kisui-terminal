// MascotOs（features/mascot/mascot.ts）の本物。`mascot.toml` と画像を読むのは Rust 側（mascot.rs）。
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import type { MascotOs } from "../../features/mascot/mascot.ts";

export const tauriMascot: MascotOs = {
  load: () => invoke("mascot_load"),
  reload: () => invoke("mascot_reload"),
  commit: (generation) => invoke("mascot_commit", { generation }),
  list: () => invoke("mascot_list"),
  select: async (name) => {
    await invoke("mascot_select", { name });
  },
  frameUrl: (id) => convertFileSrc(id, "mascot"),
};
