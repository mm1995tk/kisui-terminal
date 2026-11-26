import { invoke } from "@tauri-apps/api/core";

import type {
  DbConfigFiles,
  LocalDbConnections,
} from "../../features/db/connectionForm.ts";

/** 手元の PC の config.local.toml の DB の接続を読む・書くのは、殻（config_db.rs）。書けなければ殻の EditError（{ kind, detail }）で reject する。 */
export const tauriDbConfig: DbConfigFiles = {
  list: () => invoke<LocalDbConnections>("config_db_connections"),
  edit: (edit) =>
    invoke<LocalDbConnections>("config_db_connection_edit", { edit }),
};
