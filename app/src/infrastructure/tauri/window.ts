// 起動のときに殻へ聞くこと（index.tsx が使う）。
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** 手元の設定ファイルの `ui-language`（`en` か `ja`）。 */
export function uiLanguage(): Promise<string> {
  return invoke<string>("ui_language");
}

/** この画面の Window のラベル（Tauri の外では undefined）。 */
export function windowLabel(): string | undefined {
  try {
    return getCurrentWindow().label;
  } catch {
    return undefined;
  }
}
