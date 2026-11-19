// マシンの一覧（machineList.ts の MachineRow）で、選んでいる行を覚える。MachineDialog と MachinePicker が使う。
import { createMemo, createSignal, type Accessor } from "solid-js";

import {
  keepRow,
  moveRow,
  type MachineRow,
} from "../../../features/sessions/machineList.ts";

/**
 * 一覧で選んでいる行。選んでいるのは位置ではなくマシンで、外したり足したりして並びが変わっても同じマシンを選び続ける
 * （選んでいるマシンが消えたら、元の位置に寄せる）。
 */
export function createRowSelection(
  rows: Accessor<readonly MachineRow[]>,
  initial: string | undefined,
) {
  const [target, setTarget] = createSignal(initial);
  let last = 0;
  const index = createMemo(() => {
    last = keepRow(rows(), target(), last);
    return last;
  });
  return {
    index,
    selected: () => rows()[index()],
    /** 行（位置）を選ぶ */
    pick: (i: number) => setTarget(rows()[i]?.target),
    /** 選ぶ行を動かす */
    move: (to: "next" | "prev" | "first" | "last") =>
      setTarget(rows()[moveRow(index(), to, rows().length)]?.target),
  };
}
