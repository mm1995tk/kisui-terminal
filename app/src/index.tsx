import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { init } from "coneko-term";
import { render } from "solid-js/web";
import "./ui/styles/theme.css";
import "./ui/styles/fonts.ts";
import { POPUP_LABEL } from "./features/clipboard/history.ts";
import { lang, setLang, T } from "./i18n/index.ts";

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

// 画面の言葉は、手元の設定ファイルの `ui-language`（`en` か `ja`。無い・分からない値は英語）。
// 文は表から引くので、文を使う部品（App など）は、言葉を決めたあとに読み込む。読めなければ英語のまま
try {
  setLang(await invoke<string>("ui_language"));
} catch (e) {
  console.error("could not read ui-language", e);
}
// 文書の言語も合わせる（スクリーンリーダーの読み方・字形の選び方が変わる）
document.documentElement.lang = lang();

/** この画面が、kisui-terminal の外から開くクリップボードの履歴の窓（clipboard_popup.rs）か。 */
function isClipboardHistoryPopup(): boolean {
  try {
    return getCurrentWindow().label === POPUP_LABEL;
  } catch {
    return false;
  }
}

if (isClipboardHistoryPopup()) {
  // 履歴の一覧だけを出す（ターミナルは使わない）。窓は透明で、カードの丸い角の外は地を塗らない
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  const { ClipboardHistoryPopup } = await import("./ui/utilities/clipboard/page.tsx");
  render(() => <ClipboardHistoryPopup />, root);
} else {
  // ターミナル（coneko-term）は wasm を読み終えてから作る。読み込めないと窓が真っ白になるので、理由を出す
  try {
    await init();
    const { App } = await import("./ui/main-window/page.tsx");
    render(() => <App />, root);
  } catch (e) {
    console.error("failed to load coneko-term", e);
    root.textContent = T("boot.error", { error: String(e) });
  }
}
