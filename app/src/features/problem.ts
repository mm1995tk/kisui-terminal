// 画面の右下に出す「できなかったこと」の知らせ（見出しと理由）。機能はこれを書くだけで、どう出すかは画面（ui/main-window/notifications/）が決める。

/** できなかったこと 1 つ。 */
export interface Problem {
  title: string;
  error: string;
}

/** 知らせを出す（null は消す）。前の知らせは置き換わる。 */
export type ReportProblem = (p: Problem | null) => void;
