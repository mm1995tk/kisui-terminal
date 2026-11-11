import { getCurrentWindow } from "@tauri-apps/api/window";
import { init } from "coneko-term";
import { render } from "solid-js/web";
import "./theme.css";
import "./fonts.ts";

// dragDropEnabled: false なので、OS からのドロップは WebView に届く。受け付けた欄（TerminalView）が止めなかった
// ドロップは、既定の動き（落とされた URL に画面が置き換わる）にならないよう、ここで断る
for (const type of ["dragover", "drop"]) {
  document.addEventListener(type, (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    const dt = (e as DragEvent).dataTransfer;
    if (dt) dt.dropEffect = "none";
  });
}

const root = document.getElementById("root")!;

/** この画面が、kisui-terminal の外から開くクリップボードの履歴の窓（clipboard_popup.rs）か。 */
function isClipboardHistoryPopup(): boolean {
  try {
    return getCurrentWindow().label === "clipboard-history";
  } catch {
    return false;
  }
}

if (isClipboardHistoryPopup()) {
  // 履歴の一覧だけを出す（ターミナルは使わない）
  const { ClipboardHistoryPopup } = await import("./ClipboardHistoryPopup.tsx");
  render(() => <ClipboardHistoryPopup />, root);
} else {
  // ターミナル（coneko-term）は wasm を読み終えてから作る。読み込めないと窓が真っ白になるので、理由を出す
  try {
    await init();
    const { App } = await import("./App");
    render(() => <App />, root);
  } catch (e) {
    console.error("coneko-term の読み込みに失敗", e);
    root.textContent = `ターミナルの部品（coneko-term）を読み込めませんでした: ${String(e)}`;
  }
}
