// Workspace switcher の「タブを作る」行（SwitcherNewTab.tsx）で、選んでいるマシンの状態。部品から切り出し、node --test で確かめる。
import { createSignal, untrack } from "solid-js";

import type { MachineChoice } from "./SwitcherNewTab.tsx";
import { firstMachine, stepMachine } from "./newTabMachine.ts";

/**
 * 選んでいるマシンを持つ。machines は、いまの候補（つながっているマシン）。
 * 開いたときは initial（候補に無ければ先頭。newTabMachine.ts の firstMachine）。
 * 行を開いている間に候補が縮んでも、選んでいたマシンのまま。選んでいたマシンそのものが切れて候補から消えても、
 * ほかのマシンに黙って替えない（#461）：machine は無くなり（Enter では作らない）、gone が、選んでいたマシンを返す（切れた印と理由を出す）。
 * つながり直せば、machine に戻る。替えるのは step（Tab / Shift+Tab）と choose（一覧で決めた）だけ。
 * 選んだマシンは、名前と色ごと持つ（切れて候補から消えても、名前と色を出し続けるため）。memo や effect を使わないので、node でも確かめられる。
 */
export function createChosenMachine(
  machines: () => readonly MachineChoice[],
  initial: string,
) {
  const start = untrack(machines);
  const first = firstMachine(
    start.map((m) => m.target),
    initial,
  );
  const [chosen, setChosen] = createSignal<MachineChoice | undefined>(
    start.find((m) => m.target === first),
  );
  /** 作るマシン（候補にあるもの）。選んでいたマシンが切れていれば undefined。開いたときに候補が 0 件だったなら、いまの先頭 */
  const machine = (): MachineChoice | undefined => {
    const c = chosen();
    return c ? machines().find((m) => m.target === c.target) : machines()[0];
  };
  /** 選んでいたマシンが切れて、候補から消えた（そのマシン。消えていなければ undefined） */
  const gone = (): MachineChoice | undefined => {
    const c = chosen();
    return c && !machine() ? c : undefined;
  };
  /** 候補 t に決める（候補に無ければ何もしない） */
  function choose(t: string) {
    const m = machines().find((x) => x.target === t);
    if (m) setChosen(m);
  }
  return {
    machine,
    gone,
    /** 出すマシン（切れたマシンも出す） */
    shown: (): MachineChoice | undefined => machine() ?? gone(),
    choose,
    /** 次・前のマシンに替える（端では回る。切れたマシンからは、次は先頭・前は最後） */
    step(to: "next" | "prev") {
      const t = stepMachine(
        machines().map((m) => m.target),
        machine()?.target ?? chosen()?.target,
        to,
      );
      if (t !== undefined) choose(t);
    },
  };
}
