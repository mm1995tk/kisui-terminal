// 起動と、外への頼みの本物の組み立て。
// 機能（features/）と画面（ui/）は、外（Tauri の殻・webview の記録）への頼みを受け口の形（インターフェース）でしか知らない。
// 本物（infrastructure/）を選んで渡すのは、ここだけ。配置と依存の向きの決まりは docs/design/frontend-structure.md。
import { init } from "coneko-term";
import { render } from "solid-js/web";
import "./ui/styles/theme.css";
import "./ui/styles/tokens.css";
import "./ui/styles/fonts.ts";
import { POPUP_LABEL } from "./features/clipboard/history.ts";
import { lang, setLang, T } from "./i18n/index.ts";
import { browserStore } from "./infrastructure/storage/localStorage.ts";
import { tauriBrowser } from "./infrastructure/tauri/browser.ts";
import { tauriClipboard } from "./infrastructure/tauri/clipboard.ts";
import { tauriDbConfig } from "./infrastructure/tauri/dbConfig.ts";
import { tauriExportFile } from "./infrastructure/tauri/export.ts";
import {
  listClipboardHistory,
  tauriClipboardPopup,
} from "./infrastructure/tauri/clipboardHistory.ts";
import { tauriMascot } from "./infrastructure/tauri/mascot.ts";
import { showOsNotification } from "./infrastructure/tauri/notify.ts";
import { openUrlExternally } from "./infrastructure/tauri/openUrl.ts";
import { applyScale } from "./infrastructure/tauri/scale.ts";
import { tauriShell } from "./infrastructure/tauri/shell.ts";
import { tauriTransferOs } from "./infrastructure/tauri/transfer.ts";
import { tauriUpdates } from "./infrastructure/tauri/updates.ts";
import { uiLanguage, windowLabel } from "./infrastructure/tauri/window.ts";
import type { Ports } from "./ui/ports.ts";
import { watchTextInputs } from "./ui/components/textInputDefaults.ts";

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

// すべての入力欄で、先頭の字の大文字化・自動修正・スペルチェックを切る（#481）
watchTextInputs(document);

const root = document.getElementById("root")!;

// 画面の言葉は、手元の設定ファイルの `ui-language`（`en` か `ja`。無い・分からない値は英語）。
// 文は表から引くので、文を使う部品（画面の page.tsx など）は、言葉を決めたあとに読み込む。読めなければ英語のまま
try {
  setLang(await uiLanguage());
} catch (e) {
  console.error("could not read ui-language", e);
}
// 文書の言語も合わせる（スクリーンリーダーの読み方・字形の選び方が変わる）
document.documentElement.lang = lang();

// この画面が、kisui-terminal の外から開くクリップボードの履歴の Window（clipboard_popup.rs）か
if (windowLabel() === POPUP_LABEL) {
  // 履歴の一覧だけを出す（ターミナルは使わない）。Dialog は透明で、カードの丸い角の外は地を塗らない
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  const { ClipboardUtilityPage } =
    await import("./ui/utilities/clipboard/page.tsx");
  render(
    () => (
      <ClipboardUtilityPage
        os={tauriClipboardPopup}
        list={listClipboardHistory}
      />
    ),
    root,
  );
} else {
  // メインウィンドウが外に頼むことの本物
  const ports: Ports = {
    shell: tauriShell,
    store: browserStore(),
    browser: tauriBrowser,
    clipboard: tauriClipboard,
    clipboardHistory: listClipboardHistory,
    transfer: tauriTransferOs,
    notify: showOsNotification,
    openUrl: openUrlExternally,
    applyScale,
    mascot: tauriMascot,
    updates: tauriUpdates,
    exportFile: tauriExportFile,
    dbConfig: tauriDbConfig,
  };
  // ターミナル（coneko-term）は wasm を読み終えてから作る。読み込めないと Dialog が真っ白になるので、理由を出す
  try {
    await init();
    const { MainWindowPage } = await import("./ui/main-window/page.tsx");
    render(() => <MainWindowPage ports={ports} />, root);
  } catch (e) {
    console.error("failed to load coneko-term", e);
    root.textContent = T("boot.error", { error: String(e) });
  }
}
