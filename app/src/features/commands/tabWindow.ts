// 今出しているタブの種類ごとの窓（リーダーの `a`。#457）の、種類の決め方。
// リーダーの `a` は、どの種類のタブを出していても同じキーで、開く窓だけが種類で変わる。
// 種類を決める規則はここ 1 か所で、今の状態を集めて当てはめるのは run.ts の shownTabKind（コマンドも画面もそれを呼ぶ）。
// 窓を出し分けるのは画面の側（ui/main-window/tab-window/TabWindows.tsx）。
// DOM には触らない（node --test で確かめられる）。

/** タブの種類。 */
export type TabKind = "terminal" | "browser" | "db";

/**
 * 今出しているタブの種類。タブを出していなければ（タブが無い・ワークスペースが無い）undefined。
 * ページのタブ（ブラウザのタブ・DB のタブ）を出している間も、そのワークスペースのターミナルのタブは裏に残っているので、
 * ページのタブを先に見る（裏のターミナルのタブを、今のタブと取り違えない）。
 */
export function shownTabKind(shown: {
  /** ブラウザのタブを出している */
  browser: boolean;
  /** DB のタブを出している */
  db: boolean;
  /** ターミナルのタブがある（ページのタブを出していなければ、それを出している） */
  terminal: boolean;
}): TabKind | undefined {
  if (shown.browser) return "browser";
  if (shown.db) return "db";
  return shown.terminal ? "terminal" : undefined;
}
