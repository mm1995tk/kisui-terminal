// ssh の質問の窓（ui/main-window/sessions/AskpassDialog.tsx）に出す、質問を出した接続の行き先のマシン。
// 質問の文（prompt）は、つなぎ先のサーバーが決められる。別のマシンの質問と取り違えないよう、窓は
// どのマシンへの接続の質問かを、質問の文とは別の所に出す。その中身（名前・ssh の行き先・色）をここで決める。
// 行き先は、殻が ssh を起こすときに決めた値（AskpassRequest の target）で、つなぎ先のサーバーは変えられない。

import { labelOf, type Machine } from "./machines.ts";
import { LOCAL } from "./shell.ts";

/** ssh の質問の窓に出すマシン。 */
export interface AskpassMachine {
  /** サイドバーに出る名前（付けた名前。付けていなければ ssh の行き先） */
  label: string;
  /** ssh の行き先。名前を付けたマシンのときだけ（名前と並べて出す。label と同じになるときは無い） */
  target?: string;
  /** マシンの色（サイドバーと同じ）。サイドバーにまだ無いマシン（足すためにつないでいる最中）には無い */
  color?: string;
}

/**
 * 行き先 target のマシンの、窓に出す中身。machines は窓のマシンの一覧、colors はマシンごとの色（colors.ts）。
 * 一覧に無い行き先（足すためにつないでいる最中のマシン）は、行き先をそのまま名前にする。
 */
export function askpassMachine(
  machines: Machine[],
  colors: Record<string, string>,
  target: string,
): AskpassMachine {
  const label = labelOf(machines, target);
  const color = colors[target];
  return {
    label,
    ...(target !== LOCAL && label !== target ? { target } : {}),
    ...(color !== undefined ? { color } : {}),
  };
}
