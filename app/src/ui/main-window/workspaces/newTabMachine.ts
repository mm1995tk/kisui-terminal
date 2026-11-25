// 切り替える窓の「タブを作る」行（SwitcherNewTab.tsx）で、選んでいるマシンを target の文字列で持つための計算。
// 行を開いている間に、ほかのマシンが切れて候補が縮んでも、選んでいたマシンのままにするため、位置では持たない。
// 選んでいたマシンそのものが切れても、ほかのマシンには替えない（#461。替えるのはユーザーが Tab や一覧で選んだときだけ）。

/** target の位置。候補に無ければ 0（先頭）。候補が 0 件でも 0 を返す（そのときは machines[0] が無い） */
export function machineIndex(
  targets: readonly string[],
  target: string | undefined,
): number {
  return Math.max(0, targets.indexOf(target ?? ""));
}

/** 開いたときに選んでおくマシン。initial が候補にあればそれ、無ければ先頭（候補が 0 件なら undefined） */
export function firstMachine(
  targets: readonly string[],
  initial: string | undefined,
): string | undefined {
  return initial !== undefined && targets.includes(initial)
    ? initial
    : targets[0];
}

/**
 * target の次（next）・前（prev）のマシンの target（端では回る）。候補が 0 件なら undefined。
 * target が候補に無い（切れた）ときは、next は先頭、prev は最後
 */
export function stepMachine(
  targets: readonly string[],
  target: string | undefined,
  to: "next" | "prev",
): string | undefined {
  const n = targets.length;
  if (n === 0) return undefined;
  const at = targets.indexOf(target ?? "");
  if (at < 0) return to === "next" ? targets[0] : targets[n - 1];
  const i = at + (to === "prev" ? -1 : 1);
  return targets[(i + n) % n];
}
