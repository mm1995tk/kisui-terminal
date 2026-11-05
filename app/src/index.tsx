import { init } from "coneko-term";
import { render } from "solid-js/web";
import "./fonts.ts";
import { App } from "./App";

const root = document.getElementById("root")!;
// ターミナル（coneko-term）は wasm を読み終えてから作る。読み込めないと窓が真っ白になるので、理由を出す
try {
  await init();
  render(() => <App />, root);
} catch (e) {
  console.error("coneko-term の読み込みに失敗", e);
  root.textContent = `ターミナルの部品（coneko-term）を読み込めませんでした: ${String(e)}`;
}
