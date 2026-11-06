import { getCurrentWebview } from "@tauri-apps/api/webview";

/** webview の zoom を変える（窓の中の画面全体が同じ割合で変わる）。Tauri の外（ブラウザ）では何もしない。 */
export async function applyScale(v: number): Promise<void> {
  try {
    await getCurrentWebview().setZoom(v);
  } catch {
    // Tauri の外、または権限が無いとき
  }
}
