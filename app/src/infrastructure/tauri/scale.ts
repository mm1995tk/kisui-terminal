import { getCurrentWebview } from "@tauri-apps/api/webview";

import type { ApplyScale } from "../../features/scale/scale.ts";

/** ApplyScale の本物。webview の zoom を変える（窓の中の画面全体が同じ割合で変わる）。Tauri の外（ブラウザ）では何もしない。 */
export const applyScale: ApplyScale = async (v) => {
  try {
    await getCurrentWebview().setZoom(v);
  } catch {
    // Tauri の外、または権限が無いとき
  }
};
