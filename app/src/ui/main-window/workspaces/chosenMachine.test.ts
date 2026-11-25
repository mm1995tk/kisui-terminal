import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSignal } from "solid-js";

import type { MachineChoice } from "./SwitcherNewTab.tsx";
import { createChosenMachine } from "./chosenMachine.ts";

const m = (target: string): MachineChoice => ({
  target,
  label: target.toUpperCase(),
  color: `#${target}`,
});
const local = m("local");
const devbox = m("devbox");
const gpu = m("gpu");

/** 候補を signal で持ち、切れた・つながったを置き換えで表す */
function setup(initial: string, list = [local, devbox, gpu]) {
  const [machines, setMachines] = createSignal<readonly MachineChoice[]>(list);
  return { c: createChosenMachine(machines, initial), setMachines };
}

describe("タブを作る行の、選んでいるマシン（#461）", () => {
  it("開いたときは initial。候補に無ければ先頭", () => {
    assert.equal(setup("devbox").c.machine()?.target, "devbox");
    assert.equal(setup("gone").c.machine()?.target, "local");
  });

  it("ほかのマシンが切れても、選んでいたマシンのまま", () => {
    const { c, setMachines } = setup("gpu");
    setMachines([devbox, gpu]);
    assert.equal(c.machine()?.target, "gpu");
    assert.equal(c.gone(), undefined);
  });

  it("選んでいたマシンが切れたら、ほかに替えず、作るマシンは無い。切れたマシンを名前ごと出し続ける", () => {
    const { c, setMachines } = setup("devbox");
    setMachines([local, gpu]);
    assert.equal(c.machine(), undefined);
    assert.deepEqual(c.gone(), devbox);
    assert.deepEqual(c.shown(), devbox);
  });

  it("切れたマシンがつながり直したら、そのマシンに戻る", () => {
    const { c, setMachines } = setup("devbox");
    setMachines([local, gpu]);
    setMachines([local, devbox, gpu]);
    assert.equal(c.machine()?.target, "devbox");
    assert.equal(c.gone(), undefined);
  });

  it("切れたあと Tab で選び直すと、gone は消える（次は先頭・前は最後）", () => {
    const next = setup("devbox");
    next.setMachines([local, gpu]);
    next.c.step("next");
    assert.equal(next.c.machine()?.target, "local");
    assert.equal(next.c.gone(), undefined);
    const prev = setup("devbox");
    prev.setMachines([local, gpu]);
    prev.c.step("prev");
    assert.equal(prev.c.machine()?.target, "gpu");
  });

  it("Tab は端で回り、一覧で決めたマシンに替わる。候補に無いものには替えない", () => {
    const { c } = setup("gpu");
    c.step("next");
    assert.equal(c.machine()?.target, "local");
    c.choose("gpu");
    assert.equal(c.machine()?.target, "gpu");
    c.choose("gone");
    assert.equal(c.machine()?.target, "gpu");
  });

  it("開いたときに候補が 0 件なら、つながったマシンの先頭を作るマシンにする（切れた扱いにはしない）", () => {
    const { c, setMachines } = setup("devbox", []);
    assert.equal(c.machine(), undefined);
    assert.equal(c.gone(), undefined);
    setMachines([gpu]);
    assert.equal(c.machine()?.target, "gpu");
  });
});
