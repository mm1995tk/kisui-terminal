import { invoke } from "@tauri-apps/api/core";

import type { SaveTextFile } from "../../features/db/export.ts";

/** 保存のダイアログと、選んだ場所への書き込みは Rust 側（export.rs）がする。Dialog はパスを渡さず、受け取るだけ（やめたら null）。 */
export const tauriExportFile: SaveTextFile = ({
  defaultName,
  extension,
  text,
}) =>
  invoke<string | null>("export_save_text", { defaultName, extension, text });
