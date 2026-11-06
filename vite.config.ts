import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

// @fontsource の CSS は woff2 と、古いブラウザ向けの woff を並べて書いている。
// WebView（WebKitGTK・WKWebView・WebView2）はどれも woff2 を読むので、woff は使われないのに同梱されて重くなる。
// woff の方を CSS から消し、dist に入らないようにする。
function dropWoffFallback(): Plugin {
  return {
    name: "drop-woff-fallback",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]@fontsource[\\/].*\.css$/.test(id)) return;
      const out = code.replace(
        /,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g,
        "",
      );
      // @fontsource の書き方が変わって当たらなくなったら、黙って woff が戻らないようにビルドを止める
      if (/\.woff["']?\)/.test(out)) {
        this.error(
          `woff を消せなかった（@fontsource の CSS の書き方が変わった？）: ${id}`,
        );
      }
      return out;
    },
  };
}

// 画面のソース（index.html と src/）は app/ に置く。dist も app/dist（tauri.conf.json の frontendDist）。
// Tauri は dev のとき devUrl（tauri.conf.json）の固定ポートに繋ぎに来るので、strictPort にする。
export default defineConfig({
  root: "app",
  plugins: [dropWoffFallback(), solid()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022" },
});
