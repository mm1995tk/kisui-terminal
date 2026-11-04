import assert from "node:assert/strict";
import { test } from "node:test";

import type { KeyValueStore } from "../ssh/machines.ts";
import {
  COLORS_KEY,
  loadMachineColors,
  MACHINE_COLORS,
  machineColors,
} from "./colors.ts";

function mem(init?: string): KeyValueStore & { m: Map<string, string> } {
  const m = new Map<string, string>();
  if (init !== undefined) m.set(COLORS_KEY, init);
  return {
    m,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
  };
}

test("記録が無い・壊れている・store が無いときは空。範囲外の番号は捨てる", () => {
  assert.deepEqual(loadMachineColors(mem()), {});
  assert.deepEqual(loadMachineColors(mem("{")), {});
  assert.deepEqual(loadMachineColors(mem("[1]")), {});
  assert.deepEqual(loadMachineColors(undefined), {});
  assert.deepEqual(
    loadMachineColors(
      mem(JSON.stringify({ a: 1, b: -1, c: 1.5, d: "2", e: 99 })),
    ),
    { a: 1 },
  );
});

test("初めてのマシンには、まだ使っていない色を候補の順に割り当てる", () => {
  const s = mem();
  assert.deepEqual(machineColors(s, ["dev-vm", "build", "@local"]), {
    "dev-vm": MACHINE_COLORS[0],
    build: MACHINE_COLORS[1],
    "@local": MACHINE_COLORS[2],
  });
});

test("再起動しても同じ色（記録から読む）。つないでいないマシンの割り当ても残す", () => {
  const s = mem();
  machineColors(s, ["a", "b", "c"]);
  // 再起動して b だけつないだ
  assert.deepEqual(machineColors(s, ["b"]), { b: MACHINE_COLORS[1] });
  // 新しいマシンは、a・c と重ならない色
  assert.deepEqual(machineColors(s, ["d", "c"]), {
    d: MACHINE_COLORS[3],
    c: MACHINE_COLORS[2],
  });
  assert.deepEqual(loadMachineColors(s), { a: 0, b: 1, c: 2, d: 3 });
});

test("候補を使い切ったら、使っている数がいちばん少ないもの", () => {
  const n = MACHINE_COLORS.length;
  const init: Record<string, number> = {};
  for (let i = 0; i < n; i++) init[`m${i}`] = i;
  init.extra = 0; // 0 番だけ 2 台
  const s = mem(JSON.stringify(init));
  assert.equal(machineColors(s, ["new"]).new, MACHINE_COLORS[1]);
});

test("記録に候補の数だけマシンがあっても、いま並んでいるマシンとは重ならない", () => {
  const init: Record<string, number> = {};
  MACHINE_COLORS.forEach((_, i) => (init[`h${i}`] = i));
  const s = mem(JSON.stringify(init));
  const c = machineColors(s, ["h0", "new"]);
  assert.equal(c.h0, MACHINE_COLORS[0]);
  assert.equal(c.new, MACHINE_COLORS[1]);
  // h1 も並べると、使っている数が同じなら番号の小さいほうから、h0・h1 の色を避ける
  const s2 = mem(JSON.stringify({ ...init, extra: 2 }));
  assert.equal(machineColors(s2, ["h1", "h0", "new"]).new, MACHINE_COLORS[3]);
});

test("いま並んでいるマシンが候補を全部使っていたら、記録全体でいちばん少ないもの", () => {
  const init: Record<string, number> = {};
  MACHINE_COLORS.forEach((_, i) => (init[`m${i}`] = i));
  init.extra = 0;
  const s = mem(JSON.stringify(init));
  const targets = [...Object.keys(init), "new"];
  assert.equal(machineColors(s, targets).new, MACHINE_COLORS[1]);
});

test("割り当てが変わらなければ書かない。保存できなくても色は返す", () => {
  let writes = 0;
  const s = mem(JSON.stringify({ a: 2 }));
  const counted: KeyValueStore = {
    getItem: s.getItem,
    setItem: (k, v) => {
      writes++;
      s.setItem(k, v);
    },
  };
  machineColors(counted, ["a"]);
  assert.equal(writes, 0);

  const broken: KeyValueStore = {
    getItem: () => null,
    setItem: () => {
      throw new Error("full");
    },
  };
  assert.deepEqual(machineColors(broken, ["x"]), { x: MACHINE_COLORS[0] });
  assert.deepEqual(machineColors(undefined, ["x"]), { x: MACHINE_COLORS[0] });
});
