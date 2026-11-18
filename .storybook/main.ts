// Storybook の設定（#314）。窓の画面（app/src/）の部品を、Tauri も kisui serve も無しに、ふつうのブラウザで 1 つずつ出す。
// 動かし方・stories の足し方・外への頼みの差し替え方は docs/design/storybook.md。
// Vite の設定は根の vite.config.ts をそのまま読む（Solid の変換と、@fontsource の woff を落とす処理を、アプリと同じにする）。
import type { StorybookConfig } from "storybook-solidjs-vite";

const config: StorybookConfig = {
  framework: "storybook-solidjs-vite",
  // stories は部品の隣に置く（docs/design/frontend-structure.md の「部品をどこに置くか」）
  stories: ["../app/src/**/*.stories.tsx"],
  // 外のサービスに使い方を送らない
  core: { disableTelemetry: true },
  viteFinal(config) {
    // vite.config.ts の root（app）と、tauri dev 用の固定ポート（1420）は Storybook には要らない。
    // ポートを外さないと、tauri dev と同時に動かせない
    return {
      ...config,
      server: { ...config.server, port: undefined, strictPort: false },
    };
  },
};

export default config;
