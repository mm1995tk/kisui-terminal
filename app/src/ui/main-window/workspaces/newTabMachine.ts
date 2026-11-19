// 切り替える窓の「タブを作る」行（SwitcherNewTab.tsx）で、選んでいるマシンを target の文字列で持つための計算。
// 行を開いている間に、ほかのマシンが切れて候補が縮んでも、選んでいたマシンのまま（消えたときだけ先頭）にするため、位置では持たない。

/** target の位置。候補に無ければ 0（先頭）。候補が 0 件でも 0 を返す（そのときは machines[0] が無い） */
export function machineIndex(
  targets: readonly string[],
  target: string | undefined,
): number {
  return Math.max(0, targets.indexOf(target ?? ""));
}

/** target の次（next）・前（prev）のマシンの target（端では回る）。候補が 0 件なら undefined */
export function stepMachine(
  targets: readonly string[],
  target: string | undefined,
  to: "next" | "prev",
): string | undefined {
  const n = targets.length;
  if (n === 0) return undefined;
  const i = machineIndex(targets, target) + (to === "prev" ? -1 : 1);
  return targets[(i + n) % n];
}
