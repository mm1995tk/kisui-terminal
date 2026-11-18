// どの story にも効く設定（#314）。アプリと同じ色（theme.css）と字（fonts.ts）を読み、文は翻訳の表（app/src/i18n/）で引く。
// 言語は上の道具の「Language」で en と ja を切り替える。
import { FORCE_REMOUNT } from "storybook/internal/core-events";
import { addons } from "storybook/preview-api";
import { createDecorator, type Preview } from "storybook-solidjs-vite";

import { isLang, lang, setLang } from "../app/src/i18n/index.ts";
import "../app/src/ui/styles/theme.css";
import "../app/src/ui/styles/fonts.ts";
import "./preview.css";

// 文（T）は、部品を作ったときの言語で引く（アプリでは起動のあとに言語は変わらない）。
// そこで言語が変わったら、言語を選び直してから story を作り直させる（道具の「Remount」と同じ知らせ）
const withLang = createDecorator((Story, context) => {
  const want = isLang(context.globals.lang) ? context.globals.lang : "en";
  if (want !== lang()) {
    setLang(want);
    document.documentElement.lang = lang();
    addons.getChannel().emit(FORCE_REMOUNT, { storyId: context.id });
  }
  return Story();
});

const preview: Preview = {
  globalTypes: {
    lang: {
      description: "ui-language",
      toolbar: {
        title: "Language",
        icon: "globe",
        items: [
          { value: "en", title: "English" },
          { value: "ja", title: "日本語" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { lang: "en" },
  decorators: [withLang],
  parameters: {
    // 地はアプリと同じ（preview.css）。Storybook の背景の切り替えは使わない
    backgrounds: { disable: true },
    layout: "fullscreen",
  },
};

export default preview;
