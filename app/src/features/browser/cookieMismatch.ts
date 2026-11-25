// 外のブラウザから写した Cookie（パスキー。#206）が、渡したとおりの属性で内蔵ブラウザに入らなかったときに、右下の
// 「できなかったこと」で知らせる（#476）。確かめるのは殻（src-tauri/src/cookie_check.rs）。
import { T } from "../../i18n/index.ts";
import { onCleanup, onMount } from "solid-js";

import type { ReportProblem } from "../problem.ts";
import type { BrowserOs } from "./os.ts";

/** 殻の知らせを聞き、届いたら食い違いの行を並べて知らせる。 */
export function watchCookieMismatch(deps: {
  os: Pick<BrowserOs, "onCookieMismatch">;
  /** 内蔵ブラウザのタブを使うか（設定の [gui.browser] enabled） */
  browser: boolean;
  setFocusError: ReportProblem;
}) {
  if (!deps.browser) return;
  let off: (() => void) | undefined;
  let gone = false;
  onCleanup(() => {
    gone = true;
    off?.();
  });
  onMount(async () => {
    off = await deps.os.onCookieMismatch((problems) =>
      deps.setFocusError({
        title: T("err.browser.cookieMismatch"),
        error: problems.join("\n"),
      }),
    );
    if (gone) off();
  });
}
