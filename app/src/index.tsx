import { init } from "coneko-term";
import { render } from "solid-js/web";
import "./fonts.ts";
import { App } from "./App";

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
// ターミナル（coneko-term）は wasm を読み終えてから作る。読み込めないと窓が真っ白になるので、理由を出す
try {
  await init();
  render(() => <App />, root);
} catch (e) {
  console.error("coneko-term の読み込みに失敗", e);
  root.textContent = `ターミナルの部品（coneko-term）を読み込めませんでした: ${String(e)}`;
}
