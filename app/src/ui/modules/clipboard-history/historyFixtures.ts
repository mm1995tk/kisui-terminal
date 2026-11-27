// stories が使う、クリップボードの履歴の見本と偽の頼み（#314）。アプリは読まない。
// 履歴の一覧（HistoryPanel.stories.tsx）と、常駐ツールの Dialog（ui/utilities/clipboard/page.stories.tsx）が同じ見本を使う。
import type {
  HistoryEntry,
  ListClipboardHistory,
} from "../../../features/clipboard/history.ts";

/** 見本の履歴（新しいものが先頭）。時刻は呼んだときの今から数える。 */
export function sampleHistory(now = Date.now()): HistoryEntry[] {
  const min = 60_000;
  return [
    { text: "git switch -c issue-314-storybook", copiedAt: now - 20_000 },
    {
      text: "https://github.com/mm1995tk/kisui-terminal/issues/314",
      copiedAt: now - 3 * min,
    },
    { text: "~/ドキュメント/議事録/2026-11-18.md", copiedAt: now - 12 * min },
    {
      text: 'const config = {\n  framework: "storybook-solidjs-vite",\n};',
      copiedAt: now - 45 * min,
    },
    { text: "ssh dev@build.example.com", copiedAt: now - 3 * 60 * min },
  ];
}

/** 出すたびに entries() を返す、履歴を読む頼みの偽物。 */
export const listOf =
  (entries: () => HistoryEntry[]): ListClipboardHistory =>
  () =>
    Promise.resolve(entries());
